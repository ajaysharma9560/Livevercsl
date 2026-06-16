export default async function handler(req, res) {
  try {
    const response = await fetch(process.env.APK_URL);

    if (!response.ok) {
      return res.status(response.status).send("Fetch failed");
    }

    const contentType =
      response.headers.get("content-type") ||
      "application/octet-stream";

    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");

    res.send(buffer);
  } catch (err) {
    res.status(500).send("Server Error");
  }
}
