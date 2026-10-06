import { supabase } from "./supabase.js";
import { avatarLetter, getSavedIdentity, newIdentity, saveIdentity } from "./crypto.js";
import { APP_NAME, MAIN_GROUP_ID, VAPID_PUBLIC_KEY } from "../config.js";

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  profile: null,
  session: null,
  currentChat: null,
  chats: [],
  profiles: new Map(),
  channel: null,
  pushSubscription: null,
  booted: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function time(value) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2500);
}

function setBusy(busy) {
  $("loginButton").disabled = busy;
  $("loginButton").textContent = busy ? "Signing in…" : "Sign in";
}

function showLogin(profile = null) {
  state.booted = false;
  $("messengerView").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("nameInput").value = profile?.display_name || state.user?.user_metadata?.display_name || "";
  $("bioInput").value = profile?.bio || state.user?.user_metadata?.bio || "";
  $("loginStatus").textContent = "";
}

function showMessenger() {
  $("loginView").classList.add("hidden");
  $("messengerView").classList.remove("hidden");
}

function currentChatFromUrl() {
  const chat = new URLSearchParams(location.search).get("chat");
  return chat && /^[0-9a-f-]{36}$/i.test(chat) ? chat : MAIN_GROUP_ID;
}

async function requestNotificationPermission() {
  if (!window.isSecureContext || !("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function urlBase64ToUint8Array(base64) {
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker is not supported.");
  }

  const registration = await navigator.serviceWorker.register("./sw.js", {
    scope: "./",
  });

  await navigator.serviceWorker.ready;
  return registration;
}

function updateServiceWorkerChat(chatId = state.currentChat) {
  if (!("serviceWorker" in navigator)) return;

  const message = {
    type: "CHAT_ACTIVE",
    chatId: document.visibilityState === "visible" ? (chatId || null) : null,
  };

  const send = (registration) => {
    const worker = navigator.serviceWorker.controller || registration?.active || registration?.waiting || registration?.installing;
    if (worker) worker.postMessage(message);
  };

  if (navigator.serviceWorker.controller) {
    send();
  } else {
    navigator.serviceWorker.ready.then(send).catch(() => {});
  }
}

async function registerPush() {
  if (!state.user) return;
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("YOUR_")) return;
  if ((await requestNotificationPermission()) !== "granted") return;

  const registration = await ensureServiceWorker();
  if (!registration) return;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;

  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: state.user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    updated_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });

  if (error) throw error;
  state.pushSubscription = subscription;
}

async function upsertProfile(user, name, bio) {
  const cleanName = name.trim();
  const cleanBio = bio.trim();
  if (!cleanName) throw new Error("Please enter your name.");

  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    display_name: cleanName,
    bio: cleanBio,
  }, { onConflict: "id" });
  if (error) throw error;
  state.profile = { id: user.id, display_name: cleanName, bio: cleanBio };

  const identity = getSavedIdentity(user.id) || await newIdentity();
  saveIdentity(user.id, identity);
  await supabase.auth.updateUser({ data: { display_name: cleanName, bio: cleanBio } });
}

async function getExistingSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  state.session = data.session;
  state.user = data.session?.user || null;
  return data.session;
}

async function loadCurrentProfile() {
  if (!state.user) return null;
  const { data, error } = await supabase.from("profiles")
    .select("id,display_name,bio,public_key,created_at")
    .eq("id", state.user.id)
    .maybeSingle();
  if (error) throw error;
  state.profile = data;
  return data;
}

async function ensureMainGroup() {
  const { data, error } = await supabase.rpc("join_main_group");
  if (error) throw error;
  if (data !== MAIN_GROUP_ID) throw new Error("Joining the main group was not confirmed.");
}

async function loadChats() {
  const { data, error } = await supabase.rpc("get_my_chats");
  if (error) throw error;
  state.chats = data || [];
  renderChatList();
  return state.chats;
}


function chatDisplayName(chat) {
  if (chat?.type === "group") return "Main Group";
  return chat?.other_name || "User";
}

function chatAvatar(chat) {
  if (chat.type === "group") return "👥";
  return avatarLetter(chat.other_name || "?");
}

function renderChatList() {
  const list = $("chatList");
  list.innerHTML = state.chats.map((chat) => `
    <button class="chat-item ${chat.chat_id === state.currentChat ? "active" : ""}" data-chat="${chat.chat_id}">
      <div class="avatar">${esc(chatAvatar(chat))}</div>
      <div class="preview">
        <h4>${esc(chatDisplayName(chat))}</h4>
        <p>${esc(chat.type === "group" ? "Group" : "Private chat")}</p>
      </div>
      <time>${chat.last_message_at ? esc(time(chat.last_message_at)) : ""}</time>
    </button>
  `).join("");
  list.querySelectorAll("[data-chat]").forEach((node) => {
    node.addEventListener("click", () => openChat(node.dataset.chat));
  });
}

async function cacheProfiles(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const missing = unique.filter((id) => !state.profiles.has(id));
  if (!missing.length) return;
  const { data, error } = await supabase.from("profiles")
    .select("id,display_name,bio,public_key")
    .in("id", missing);
  if (error) throw error;
  for (const profile of data || []) state.profiles.set(profile.id, profile);
}

async function getMessages(chatId) {
  const { data, error } = await supabase.from("messages")
    .select("id,chat_id,sender_id,ciphertext,message_type,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  await cacheProfiles((data || []).map((m) => m.sender_id));
  return data || [];
}

function readSystemText(ciphertext) {
  try {
    const data = JSON.parse(ciphertext || "{}");
    const text = String(data.systemText || "System message");
    return text.endsWith(" به گروه پیوست") ? `${text.slice(0, -14)} joined the group` : text;
  } catch {
    return "System message";
  }
}

function renderMessage(message) {
  if (message.message_type === "system") {
    return `<div class="day-label">${esc(readSystemText(message.ciphertext))}</div>`;
  }
  const profile = state.profiles.get(message.sender_id);
  const mine = message.sender_id === state.user?.id;
  // v1 keeps transport content in the ciphertext column. The E2EE key protocol is intentionally a separate hardening step.
  let text = "Message";
  try {
    const payload = JSON.parse(message.ciphertext);
    text = payload.text || "Message";
  } catch {
    text = "Message";
  }
  return `<div class="msg-row ${mine ? "mine" : "other"}">
    <button class="avatar" data-profile="${esc(message.sender_id || "")}" aria-label="Profile">${esc(avatarLetter(profile?.display_name))}</button>
    <div>
      <div class="msg-author">${esc(profile?.display_name || "User")}</div>
      <div class="bubble">${esc(text)}<span class="bubble-meta">${esc(time(message.created_at))}</span></div>
    </div>
  </div>`;
}

async function openChat(chatId) {
  if (!state.user) return;
  const allowed = state.chats.some((chat) => chat.chat_id === chatId);
  const target = allowed ? chatId : MAIN_GROUP_ID;
  const chat = state.chats.find((item) => item.chat_id === target);
  if (!chat) return toast("Chat not found.");

  state.currentChat = target;
  history.replaceState(null, "", `${location.pathname}${target === MAIN_GROUP_ID ? "" : `?chat=${encodeURIComponent(target)}`}`);
  updateServiceWorkerChat(target);
  $("messengerView").classList.add("mobile-chat");
  $("chatTitle").textContent = chatDisplayName(chat);
  $("chatSubtitle").textContent = chat.type === "group" ? "Main Group" : "Private chat";
  $("chatAvatar").textContent = chatAvatar(chat);

  const messages = await getMessages(target);
  $("messages").innerHTML = messages.map(renderMessage).join("");
  requestAnimationFrame(() => { $("messages").scrollTop = $("messages").scrollHeight; });
  renderChatList();
}

async function createDm(otherUserId) {
  if (!otherUserId || otherUserId === state.user.id) return;
  const { data, error } = await supabase.rpc("get_or_create_dm", { other_user_id: otherUserId });
  if (error) throw error;
  const chatId = Array.isArray(data) ? data[0]?.chat_id : data?.chat_id;
  if (!chatId) throw new Error("Failed to create private chat.");
  await loadChats();
  await openChat(chatId);
}

async function sendMessage(text) {
  if (!state.currentChat || !state.user) return;
  const clean = text.trim();
  if (!clean) return;
  const ciphertext = JSON.stringify({ v: 1, text: clean });
  const { error } = await supabase.from("messages").insert({
    chat_id: state.currentChat,
    sender_id: state.user.id,
    ciphertext,
    message_type: "text",
  });
  if (error) throw error;
}

function subscribeRealtime() {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = supabase.channel(`messages-${state.user.id}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "messages",
    }, async (payload) => {
      const message = payload.new;
      const knownChat = state.chats.some((c) => c.chat_id === message.chat_id);
      if (!knownChat) {
        await loadChats().catch(console.warn);
        return;
      }
      if (message.sender_id) await cacheProfiles([message.sender_id]);
      if (message.chat_id === state.currentChat) {
        const box = $("messages");
        if (!box.querySelector(`[data-message-id="${message.id}"]`)) {
          const temp = document.createElement("div");
          temp.innerHTML = renderMessage(message);
          const node = temp.firstElementChild;
          node?.setAttribute("data-message-id", message.id);
          if (node) box.appendChild(node);
          box.scrollTop = box.scrollHeight;
        }
      }
      await loadChats().catch(console.warn);
    })
    .subscribe((status) => {
      $("chatSubtitle").dataset.realtime = status;
    });
}

async function bootstrapAuthenticated() {
  const session = await getExistingSession();
  if (!session?.user) {
    showLogin();
    return;
  }
  state.user = session.user;
  const profile = await loadCurrentProfile();
  if (!profile) {
    showLogin();
    return;
  }
  await ensureMainGroup();
  showMessenger();
  await loadChats();
  const requested = currentChatFromUrl();
  await openChat(requested);
  subscribeRealtime();
  await registerPush().catch((error) => console.warn("push", error));
  state.booted = true;
}

async function login() {
  const name = $("nameInput").value.trim();
  const bio = $("bioInput").value.trim();
  if (!name) {
    $("loginStatus").textContent = "Please enter your name.";
    return;
  }

  // Start permission while the user activation is still fresh.
  const permissionPromise = requestNotificationPermission();
  setBusy(true);
  $("loginStatus").textContent = "Signing in…";
  try {
    let session = (await getExistingSession());
    if (!session?.user) {
      const { data, error } = await supabase.auth.signInAnonymously({
        options: { data: { display_name: name, bio } },
      });
      if (error) throw error;
      session = data.session;
    }
    if (!session?.user) throw new Error("User session could not be created.");

    state.session = session;
    state.user = session.user;
    await upsertProfile(state.user, name, bio);
    await ensureMainGroup();
    showMessenger();
    await loadChats();
    await openChat(MAIN_GROUP_ID);
    subscribeRealtime();

    const permission = await permissionPromise;
    if (permission === "granted") await registerPush();
    else toast("Notifications were not enabled. You can enable them later in your browser settings.");
  } catch (error) {
    console.error(error);
    $("loginStatus").textContent = error?.message || "Sign-in failed.";
    showLogin(state.profile);
  } finally {
    setBusy(false);
  }
}

document.addEventListener("visibilitychange", () => updateServiceWorkerChat());
window.addEventListener("focus", () => updateServiceWorkerChat());
window.addEventListener("pageshow", () => updateServiceWorkerChat());

$("profileForm").addEventListener("submit", (event) => {
  event.preventDefault();
  login();
});

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  $("sendButton").disabled = true;
  try {
    await sendMessage(text);
    input.value = "";
    input.style.height = "auto";
  } catch (error) {
    console.error(error);
    toast("Failed to send message.");
  } finally {
    $("sendButton").disabled = false;
  }
});

$("messageInput").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`;
});

$("backBtn").addEventListener("click", () => $("messengerView").classList.remove("mobile-chat"));
$("myProfileBtn").addEventListener("click", () => showProfile(state.profile));
$("chatInfoBtn").addEventListener("click", () => {
  const chat = state.chats.find((item) => item.chat_id === state.currentChat);
  if (!chat) return;
  $("infoContent").innerHTML = `<h2>${esc(chatDisplayName(chat))}</h2><p class="muted">${esc(chat.type === "group" ? "Every new member joins the main group automatically." : "Private chat")}</p>`;
  $("infoDialog").showModal();
});

document.addEventListener("click", (event) => {
  const profileButton = event.target.closest("[data-profile]");
  if (!profileButton) return;
  const profile = state.profiles.get(profileButton.dataset.profile);
  if (profile) showProfile(profile, true);
});

document.querySelectorAll("[data-close]").forEach((node) => {
  node.addEventListener("click", () => node.closest("dialog")?.close());
});

async function showProfile(profile, allowDm = false) {
  $("profileContent").innerHTML = `<div class="profile-card">
    <div class="big-avatar">${esc(avatarLetter(profile.display_name))}</div>
    <h2>${esc(profile.display_name)}</h2>
    <div class="bio">${esc(profile.bio || "No bio set.")}</div>
    ${allowDm && profile.id !== state.user?.id ? '<button id="profileDmBtn" class="primary" style="margin-top:16px;width:100%">Send message</button>' : ""}
  </div>`;
  $("profileDialog").showModal();
  $("profileDmBtn")?.addEventListener("click", async () => {
    try {
      $("profileDmBtn").disabled = true;
      await createDm(profile.id);
      $("profileDialog").close();
    } catch (error) {
      console.error(error);
      toast(error?.message || "Failed to create private chat.");
    }
  });
}

$("appName").textContent = APP_NAME;
document.title = APP_NAME;

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    state.session = null;
    state.user = null;
    state.profile = null;
    showLogin();
  }
  // Do not await inside the auth callback: Supabase warns about callbacks that synchronously trigger other auth calls.
  if (event === "INITIAL_SESSION" && !state.booted) {
    setTimeout(() => bootstrapAuthenticated().catch((error) => {
      console.error(error);
      showLogin();
    }), 0);
  }
});

(async function init() {
  try {
    await ensureServiceWorker();
    await bootstrapAuthenticated();
  } catch (error) {
    console.error(error);
    showLogin();
  }
})();
