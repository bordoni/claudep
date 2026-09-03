/**
 * Stand-in for macOS `security`. Exits 0 when the requested service name is
 * listed in $FAKE_KEYCHAIN (comma separated), 44 otherwise, like the real tool.
 */
const argv = process.argv.slice(2);
const i = argv.indexOf("-s");
const service = i !== -1 ? argv[i + 1] : undefined;
const known = (process.env.FAKE_KEYCHAIN ?? "").split(",").filter(Boolean);
process.exit(service !== undefined && known.includes(service) ? 0 : 44);
