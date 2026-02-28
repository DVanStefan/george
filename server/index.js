import path from "path";
import { fileURLToPath } from "url";
import { startDashboard } from "../src/lib/dashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cwd = process.env.APP_CWD || path.resolve(__dirname, "..");
const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 4173);

startDashboard({ cwd, port });

