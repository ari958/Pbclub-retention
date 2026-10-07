// Load the real entrypoint only after installing the fixture's transport guard.
// Static imports would run application initialization before this guard.
if (process.env.NODE_ENV !== "production" || process.env.SMS_LIVE !== "false") {
  throw new Error("Unsafe synthetic application environment");
}
globalThis.fetch = async () => { throw new Error("Network forbidden in worker fixture"); };
void import("../../../index").catch(error => {
  process.stderr.write(`Fixture application import failed: ${String(error)}\n`);
  process.exit(2);
});
