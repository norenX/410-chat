import { useEffect } from "react";

export function HowItWorksPage() {
  useEffect(() => {
    document.title = "How it works — 410";
  }, []);

  return (
    <main className="security-page how-page">
      <article className="security-document how-document">
        <header className="security-header">
          <a className="security-brand" href="/" aria-label="410">410</a>
          <a
            className="security-source"
            href="https://github.com/norenX/410-chat"
            target="_blank"
            rel="noopener noreferrer"
          >Source code → GitHub</a>
        </header>

        <h1>How it works</h1>
        <p className="security-introduction">410 is temporary by design.</p>

        <section aria-labelledby="how-one-to-one">
          <h2 id="how-one-to-one">1-TO-1</h2>
          <p>One-use invite.<br />Two people.<br />30 minutes.</p>
          <p>Once the second person joins, the invite cannot be used again.</p>
        </section>

        <section aria-labelledby="how-room">
          <h2 id="how-room">ROOM</h2>
          <p>Reusable invite.<br />Up to 10 people.<br />24 hours.</p>
          <p>People can leave and come back while the room still exists.</p>
          <p>Room members get temporary names that exist only inside that room.</p>
        </section>

        <section aria-labelledby="how-history">
          <h2 id="how-history">NO HISTORY</h2>
          <p>Messages are not stored as chat history.</p>
          <p>You only see messages sent while you&apos;re there.</p>
          <p>Reloading or rejoining does not bring old messages back.</p>
        </section>

        <section aria-labelledby="how-gone">
          <h2 id="how-gone">GONE</h2>
          <p>Destroy a conversation or let it expire.</p>
          <p>After that, its link returns:</p>
          <p className="how-gone-status">410 Gone</p>
          <p>No account. No permanent contact. No conversation to come back to.</p>
        </section>

        <nav className="how-links" aria-label="More information">
          <a href="/security">Security →</a>
          <a href="/">Back →</a>
        </nav>
      </article>
    </main>
  );
}
