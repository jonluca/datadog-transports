import {
  type DDTransportOptions,
  DataDogTransport,
} from "@weights/datadog-transport-common";
import build from "pino-abstract-transport";
export const convertLevel = (level: number | string): string => {
  if (typeof level === "string") {
    return level;
  }

  if (level >= 60) {
    return "fatal";
  }
  if (level >= 50) {
    return "error";
  }
  if (level >= 40) {
    return "warning";
  }
  if (level >= 30) {
    return "info";
  }
  if (level >= 20) {
    return "debug";
  }

  return "trace";
};

export default (options: DDTransportOptions) => {
  const transport = new DataDogTransport(options);

  return build(async function processLogs(source) {
    for await (const obj of source) {
      if (!obj) {
        if (options.onDebug) {
          options.onDebug("Log source object is empty");
        }

        return;
      }

      // Datadog uses the date field for timestamp
      obj.date = obj.time;
      delete obj.time;

      transport.processLog({
        ...obj,
        level: convertLevel(obj.level),
      });
    }
  });
};
