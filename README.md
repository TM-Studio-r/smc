# Class gap — v1 Login-fixed + Push-ready

This build is a static GitHub Pages PWA backed by Supabase.

## What was fixed
- Persistent Supabase session is checked before creating a new anonymous user.
- Existing browser sessions open the messenger directly after refresh.
- Anonymous profile data is stored in Auth metadata as well as `profiles`.
- Group ID is a real UUID everywhere; no more `main`/UUID mismatch.
- Group join is done through a server-side RPC, including the join system message.
- The old recursive RLS policy on `conversation_members` is replaced with a security-definer membership check.
- Chat list is returned by `get_my_chats()` and sorted by last message time.
- DM creation is deterministic: exactly one conversation per pair.
- Web Push registration is requested from the login gesture and stored per device.
- Service Worker suppresses a push notification when that exact chat is already open.
- Notification click opens the exact chat.
- Expired Push subscriptions (404/410) are removed by the Edge Function.

## REQUIRED before deploy
Run:
`supabase/migrations/20261005_v1_fix.sql`

Do not skip this migration. It fixes the RLS recursion and installs the RPCs used by the new frontend.

## Supabase Edge Function secrets
Keep these in Supabase Edge Function Secrets:
- VAPID_PRIVATE_KEY
- VAPID_SUBJECT
- PUSH_SUPABASE_SECRET_KEY

Do not put the VAPID private key or Supabase secret key in the browser bundle.

## Database Webhook
Existing webhook should target Edge Function `send-push`:
- table: `public.messages`
- event: INSERT
- method: POST
- add auth header with service key: enabled

## Deploy
Upload all files in this folder to the GitHub Pages branch/folder. Serve over HTTPS.

## First Chrome Android test
1. Open the HTTPS GitHub Pages URL in Chrome.
2. Enter name + bio and press Login.
3. Accept notification permission.
4. Check `push_subscriptions` for one row for the device.
5. From a different user/device send a message.
6. Check the Android notification.
7. Tap it and confirm the exact chat opens.

## Important security status
The database uses a `ciphertext` column, but this v1 build does NOT claim production-grade E2EE. A correct group+DM E2EE protocol with history visibility (your choice A), device recovery, multi-device support and key rotation requires a dedicated key-management phase. The UI and data model are prepared for that phase instead of pretending a plaintext preview is encrypted.
