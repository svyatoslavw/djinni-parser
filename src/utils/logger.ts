import logger, { Logger as LoggerType } from "pino"

export class Logger {
  private logger: LoggerType

  constructor() {
    this.logger = logger({
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname"
        }
      }
    })
  }

  public info(message: string): void {
    this.logger.info(message)
  }

  public error(message: string): void {
    this.logger.error("Помилка: " + message)
  }
}
