import { ChildProcess, fork } from "child_process"
import { POLL_INTERVAL_MS, WORKER_RESTART_DELAY_MS } from "../common"
import { FeedPollerService } from "../services"
import { Logger } from "../utils"
import { BotApplication } from "./bot-application"
import { createBaseContainer, createBotContainer } from "./container"

// ==================================================================== //
//                             WorkerProcess                            //
// ==================================================================== //

export class WorkerProcess {
  private container = createBaseContainer()
  private logger = this.container.resolve<Logger>("logger")
  private feedPollerService = this.container.resolve<FeedPollerService>("feedPollerService")
  private timer?: NodeJS.Timeout

  async start(): Promise<void> {
    await this.run()
    this.startPolling()
    this.setupProcessHandlers()
    this.logger.info(`Polling worker started. Interval: ${POLL_INTERVAL_MS}ms`)
  }

  private async run(): Promise<void> {
    try {
      await this.feedPollerService.pollAllUsers()
    } catch (error) {
      this.logger.error(`Poll cycle failed: ${error}`)
    }
  }

  private startPolling(): void {
    this.timer = setInterval(() => {
      void this.run()
    }, POLL_INTERVAL_MS)
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.logger.info("Polling worker stopped")
    process.exit(0)
  }

  private setupProcessHandlers(): void {
    process.on("SIGINT", () => this.stop())
    process.on("SIGTERM", () => this.stop())
    process.on("uncaughtException", (error) => {
      this.logger.error(`Polling worker crashed (uncaughtException): ${error}`)
      process.exit(1)
    })
    process.on("unhandledRejection", (reason) => {
      this.logger.error(`Polling worker crashed (unhandledRejection): ${String(reason)}`)
      process.exit(1)
    })
  }
}

// ==================================================================== //
//                              BotProcess                              //
// ==================================================================== //

export class BotProcess {
  private container = createBotContainer()
  private logger = this.container.resolve<Logger>("logger")
  private pollWorker: ChildProcess | null = null
  private isShuttingDown = false

  async start(): Promise<void> {
    this.setupExitHandler()
    this.spawn()
    this.container.resolve<BotApplication>("botApplicationp").start()
  }

  private setupExitHandler(): void {
    process.once("exit", () => this.stop())
  }

  private spawn(): void {
    const worker = fork(__filename, [], {
      env: { ...process.env, APP_MODE: "WORKER" },
      stdio: "inherit"
    })

    this.pollWorker = worker
    this.logger.info(`Polling worker started (pid=${worker.pid ?? "n/a"})`)

    worker.on("error", (error) => this.logger.error(`Polling worker process error: ${error}`))

    worker.on("exit", (code, signal) => {
      this.logger.error(
        `Polling worker exited (pid=${worker.pid ?? "n/a"}, code=${code ?? "null"}, signal=${signal ?? "null"})`
      )

      if (!this.isShuttingDown) {
        setTimeout(() => this.spawn(), WORKER_RESTART_DELAY_MS)
      }
    })
  }

  private stop(): void {
    this.isShuttingDown = true
    if (this.pollWorker && !this.pollWorker.killed) {
      this.pollWorker.kill("SIGTERM")
    }
  }
}
