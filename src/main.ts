import { BotProcess, WorkerProcess } from "@/app"
import { APP_MODE } from "./common"

if (APP_MODE === "WORKER") {
  new WorkerProcess().start().catch(console.error)
} else {
  new BotProcess().start().catch(console.error)
}
