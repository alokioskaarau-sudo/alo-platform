import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  fileURLToPath,
} from "node:url";

type WorkerSuccess = {
  ok: true;
  imageBase64: string;
};

type WorkerFailure = {
  ok: false;
  error: string;
};

type WorkerResponse =
  | WorkerSuccess
  | WorkerFailure;

const WORKER_TIMEOUT_MS =
  120_000;

function getWorkerCommand(): {
  command: string;
  args: string[];
} {
  const isTypeScript =
    import.meta.url.endsWith(".ts");

  if (isTypeScript) {
    const workerPath =
      fileURLToPath(
        new URL(
          "../workers/backgroundRemoval.worker.ts",
          import.meta.url
        )
      );

    return {
      command:
        process.platform === "win32"
          ? "npx.cmd"
          : "npx",
      args: [
        "tsx",
        workerPath,
      ],
    };
  }

  const workerPath =
    fileURLToPath(
      new URL(
        "../workers/backgroundRemoval.worker.js",
        import.meta.url
      )
    );

  return {
    command: process.execPath,
    args: [
      workerPath,
    ],
  };
}

export async function removeBackgroundIsolated(
  imageBuffer: Buffer
): Promise<Buffer> {
  if (
    !Buffer.isBuffer(imageBuffer) ||
    imageBuffer.length === 0
  ) {
    throw new Error(
      "Background Removal benötigt gültige Bilddaten."
    );
  }

  const {
    command,
    args,
  } = getWorkerCommand();

  return await new Promise<Buffer>(
    (
      resolve,
      reject
    ) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      let child:
        ChildProcessWithoutNullStreams;

      try {
        child = spawn(
          command,
          args,
          {
            stdio: [
              "pipe",
              "pipe",
              "pipe",
            ],
            env: process.env,
          }
        );
      } catch (error) {
        reject(error);
        return;
      }

      const finishReject = (
        error: Error
      ) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      const finishResolve = (
        buffer: Buffer
      ) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve(buffer);
      };

      const timeout =
        setTimeout(
          () => {
            child.kill("SIGKILL");

            finishReject(
              new Error(
                `Background Removal Worker Timeout nach ${WORKER_TIMEOUT_MS / 1000}s.`
              )
            );
          },
          WORKER_TIMEOUT_MS
        );

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on(
        "data",
        (chunk: string) => {
          stdout += chunk;
        }
      );

      child.stderr.on(
        "data",
        (chunk: string) => {
          stderr += chunk;
        }
      );

      child.on(
        "error",
        (error) => {
          finishReject(
            new Error(
              `Background Removal Worker konnte nicht gestartet werden: ${error.message}`
            )
          );
        }
      );

      child.on(
        "close",
        (
          code,
          signal
        ) => {
          if (settled) {
            return;
          }

          let response:
            WorkerResponse;

          try {
            response =
              JSON.parse(
                stdout.trim()
              ) as WorkerResponse;
          } catch {
            const details =
              stderr.trim() ||
              stdout.trim() ||
              "keine Worker-Ausgabe";

            finishReject(
              new Error(
                `Ungültige Antwort vom Background Removal Worker: ${details}`
              )
            );
            return;
          }

          if (
            code !== 0 ||
            signal !== null ||
            response.ok !== true
          ) {
            const responseError =
              response.ok === false
                ? response.error
                : "";

            const details =
              responseError ||
              stderr.trim() ||
              `Exit-Code ${String(code)}, Signal ${String(signal)}`;

            finishReject(
              new Error(
                `Background Removal Worker fehlgeschlagen: ${details}`
              )
            );
            return;
          }

          if (
            typeof response.imageBase64 !==
              "string" ||
            !response.imageBase64
          ) {
            finishReject(
              new Error(
                "Background Removal Worker lieferte keine Bilddaten."
              )
            );
            return;
          }

          const output =
            Buffer.from(
              response.imageBase64,
              "base64"
            );

          if (output.length === 0) {
            finishReject(
              new Error(
                "Background Removal Worker lieferte ein leeres Bild."
              )
            );
            return;
          }

          finishResolve(output);
        }
      );

      const request =
        JSON.stringify({
          imageBase64:
            imageBuffer.toString(
              "base64"
            ),
        });

      child.stdin.on(
        "error",
        (error) => {
          finishReject(
            new Error(
              `Bilddaten konnten nicht an Background Removal Worker gesendet werden: ${error.message}`
            )
          );
        }
      );

      child.stdin.end(
        request,
        "utf8"
      );
    }
  );
}
