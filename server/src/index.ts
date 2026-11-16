import { createApp } from "./app.js";

const ctx = createApp();
const { config } = ctx;

ctx.app.listen(config.port, () => {
  console.log(`cloneME server listening on :${config.port} (public url ${config.publicBaseUrl})`);
  const modes = Object.entries(config.vendors).map(([k, v]) => `${k}=${v.mock ? "mock" : "live"}`);
  console.log(`vendors: ${modes.join(" ")}`);
  if (ctx.ownerBootstrap.awaitingClaim) {
    console.log("Waiting for the owner to finish setup in the cloneME app (setup token required).");
  }
  if (ctx.ownerBootstrap.created) {
    if (ctx.ownerBootstrap.code) {
      console.log(`Owner account created. Owner invite code (shown once): ${ctx.ownerBootstrap.code}`);
    } else {
      console.log("Owner account created using OWNER_INVITE_CODE.");
    }
  }
});
