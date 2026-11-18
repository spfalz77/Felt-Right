# Switching on guest play and email-code sign-in (live project)

Both are built and merged; each waits behind a switch in `feature_flags` until the live Supabase project is set up for it.

## Guest play (`guest_play`)
1. Supabase dashboard → Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins**.
2. (Recommended) Authentication → Attack Protection → turn on CAPTCHA (Turnstile) to stop bots creating guests.
3. Switch it on: `update public.feature_flags set state = 'on' where key = 'guest_play';`

## Sign in with an emailed code (`email_code_login`)
Supabase's built-in email only sends to the project's team members and only a few an hour, so codes need your own sender.
1. Make a free account with an email provider that gives SMTP (e.g. Resend), verify a sending domain or address.
2. Dashboard → Authentication → Emails → SMTP Settings: turn on custom SMTP and enter the provider's host, port, user and password, and a sender like `Felt Right <codes@yourdomain>`.
3. Dashboard → Authentication → Emails → Templates: in **Magic Link**, **Confirm signup** and **Change Email Address**, set the subject to `Your Felt Right code` and the body to the contents of `supabase/templates/code.html` (it shows `{{ .Token }}`, the 6-digit code).
4. Authentication → Sign In / Providers → Email: keep **Confirm email** and **Secure email change** on (without them a guest could claim an email address without owning it). Email OTP length 6.
5. Authentication → Rate Limits: raise "emails sent per hour" to something like 100.
6. Switch it on: `update public.feature_flags set state = 'on' where key = 'email_code_login';`
   From then on the splash shows "Email me a code"; passwords disappear from the screens (existing accounts sign in with a code to the same email); guests verify and keep their identity.

## Later
- Guest hosting, after store launch: `update public.feature_flags set state = 'on' where key = 'guest_hosting';`
- See everything at once: `select * from public.feature_status();`
