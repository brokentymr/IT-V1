export default function Home() {
  return (
    <main style={{ padding: "3rem", maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>Investing Together</h1>
      <p style={{ color: "#555", marginTop: 0 }}>Investing, together — for everyday people.</p>
      <p>
        Phase&nbsp;0 provisioning is live. Platform health:{" "}
        <a href="/api/health">/api/health</a>.
      </p>
    </main>
  );
}
