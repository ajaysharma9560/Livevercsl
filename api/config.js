export default async function handler(req, res) {
  try {
    const response = await fetch(process.env.APK_URL);

    if (!response.ok) {
      return res.status(response.status).send("Fetch failed");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "application/octet-stream"
    );

    res.send(buffer);
  } catch (e) {
    res.status(500).send("Server Error");
  }
}
