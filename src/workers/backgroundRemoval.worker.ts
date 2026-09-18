import { removeBackground } from "@imgly/background-removal-node";

type WorkerRequest = {
  imageBase64: string;
};

type WorkerResponse =
  | {
      ok: true;
      imageBase64: string;
    }
  | {
      ok: false;
      error: string;
    };

async function main(): Promise<void> {
  let input = "";

  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const request =
      JSON.parse(input) as WorkerRequest;

    if (
      !request ||
      typeof request.imageBase64 !== "string" ||
      !request.imageBase64
    ) {
      throw new Error(
        "Worker hat keine gültigen Bilddaten erhalten."
      );
    }

    const imageBuffer =
      Buffer.from(
        request.imageBase64,
        "base64"
      );

    /*
     * IMG.LY benötigt für die Bilddekodierung
     * einen Blob mit gesetztem MIME-Type.
     *
     * Ein nackter Buffer/Uint8Array wird von
     * IMG.LY intern zu einem Blob ohne type
     * konvertiert und endet dadurch in:
     * "Unsupported format:"
     */
    const imageBlob =
      new Blob(
        [new Uint8Array(imageBuffer)],
        {
          type: "image/png",
        }
      );

    const result =
      await removeBackground(
        imageBlob,
        {
          debug: false,
          model: "medium",
          output: {
            format: "image/png",
            quality: 1,
          },
        }
      );

    const arrayBuffer =
      await result.arrayBuffer();

    const response: WorkerResponse = {
      ok: true,
      imageBase64:
        Buffer.from(arrayBuffer)
          .toString("base64"),
    };

    process.stdout.write(
      JSON.stringify(response)
    );
  } catch (error) {
    const response: WorkerResponse = {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Background Removal Worker fehlgeschlagen.",
    };

    process.stdout.write(
      JSON.stringify(response)
    );

    process.exitCode = 1;
  }
}

void main();
