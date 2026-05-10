# Shipmastr SMTP deploy note

Seller email verification uses these Cloud Run environment variables:

```text
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_FROM
SMTP_SECURE
SMTP_REPLY_TO
```

`/api/auth/register/request-code` returns `SMTP_NOT_CONFIGURED` until `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are present. For Google Workspace Gmail SMTP, use `SMTP_PORT=465` and `SMTP_SECURE=true`.

Prefer Secret Manager for the SMTP password:

```bash
printf '%s' 'REAL_16_CHAR_GOOGLE_APP_PASSWORD' | gcloud secrets versions add shipmastr-smtp-pass --project shipmastr-core-prod --data-file=-
gcloud run services update shipmastr-api \
  --region asia-south1 \
  --project shipmastr-core-prod \
  --update-secrets SMTP_PASS=shipmastr-smtp-pass:latest \
  --update-env-vars SMTP_HOST=smtp.gmail.com,SMTP_PORT=465,SMTP_SECURE=true,SMTP_USER=blog@shipmastr.com,SMTP_FROM='Shipmastr <blog@shipmastr.com>',SMTP_REPLY_TO=support@shipmastr.com
```

Use the Google Workspace app password for `blog@shipmastr.com`, not a seller signup password and not the normal mailbox password. Test signup with a real receiving inbox that is different from the sender address.

Do not commit or paste the real SMTP password into source files.
