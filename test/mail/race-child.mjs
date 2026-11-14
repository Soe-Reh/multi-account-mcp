// One "process" of the race test: sends a draft with a bundled copy of the engine and prints the outcome.
const [engine, json] = process.argv.slice(2);
const { createMailClient } = await import(engine);
const { account, creds, id, startAt } = JSON.parse(json);
await new Promise((r) => setTimeout(r, startAt - Date.now())); // all four start together
try {
  await createMailClient({ timeoutMs: 8000 }).sendDraft(account, creds, id);
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
}
