import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = "BFaDm5Gd_q4f01OgOQZSbhbrNlSFgmih2MIoMQGjrQTVdG60zR9310hgprmXrPL27N-RSlIilNZMtdkTBcTMKsQ";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("PUSH_SUPABASE_SECRET_KEY");

if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Required push environment variables are missing.");
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const restHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return Response.json({ ok: false, error: "POST only" }, { status: 405 });

    const payload = await req.json();
    const record = payload?.record;
    if (payload?.type !== "INSERT" || payload?.table !== "messages" || payload?.schema !== "public" || !record) {
      return Response.json({ ok: true, ignored: true });
    }
    if (record.message_type === "system" || !record.sender_id) {
      return Response.json({ ok: true, ignored: true });
    }

    const chatId = record.chat_id;
    const senderId = record.sender_id;

    const membersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversation_members?chat_id=eq.${encodeURIComponent(chatId)}&select=user_id`,
      { headers: restHeaders },
    );
    if (!membersRes.ok) throw new Error(`members: ${await membersRes.text()}`);
    const members = await membersRes.json();
    const recipientIds = members.map((row: { user_id: string }) => row.user_id).filter((id: string) => id !== senderId);
    if (!recipientIds.length) return Response.json({ ok: true, sent: 0 });

    let senderName = "کاربر";
    const senderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(senderId)}&select=display_name&limit=1`,
      { headers: restHeaders },
    );
    if (senderRes.ok) {
      const rows = await senderRes.json();
      if (rows[0]?.display_name) senderName = rows[0].display_name;
    }

    let title = "پیام جدید";
    const chatRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(chatId)}&select=title,type&limit=1`,
      { headers: restHeaders },
    );
    if (chatRes.ok) {
      const chats = await chatRes.json();
      if (chats[0]?.type === "group") title = chats[0]?.title || "گروه اصلی";
      else title = senderName;
    }

    const quotedIds = recipientIds.map((id: string) => `"${id.replaceAll('"', '""')}"`).join(",");
    const subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=in.(${quotedIds})&select=id,user_id,endpoint,p256dh,auth`,
      { headers: restHeaders },
    );
    if (!subsRes.ok) throw new Error(`subscriptions: ${await subsRes.text()}`);
    const subscriptions = await subsRes.json();

    let sent = 0;
    let failed = 0;
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({
            title,
            body: `${senderName} پیام جدیدی فرستاد`,
            chatId,
            url: `./?chat=${encodeURIComponent(chatId)}`,
          }),
        );
        sent++;
      } catch (error) {
        failed++;
        const status = (error as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
            { method: "DELETE", headers: restHeaders },
          );
        }
        console.error("push failed", error);
      }
    }

    return Response.json({ ok: true, sent, failed, subscriptions: subscriptions.length });
  } catch (error) {
    console.error(error);
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
});
