import { loadConfig } from "./config.js";
import { createHttpApp } from "./app.js";
import { logEvent } from "./logger.js";

const config = loadConfig();
const app = await createHttpApp(config);

app.listen(config.port, config.host, () => {
  logEvent("info", "server_started", {
    host: config.host,
    port: config.port,
    mcpPath: config.mcpPath,
    defaultTarget: config.defaultTarget,
    targets: Object.keys(config.targets).sort()
  });
});
