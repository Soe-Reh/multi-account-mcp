// One sender "process" for the kill -9 / clock-skew tests: optional clock skew, prints the outcome as JSON.
const [engine, json] = process.argv.slice(2);
const { account, creds, id, startAt = 0, skewMs = 0 } = JSON.parse(json);
if (skewMs) { const real = Date.now.bind(Date); Date.now = () => real() + skewMs; }
const { createMailClient } = await import(engine);
const wait = startAt - Date.now() + skewMs;
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
try {
  await createMailClient({ timeoutMs: 8000 }).sendDraft(account, creds, id);
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
}
