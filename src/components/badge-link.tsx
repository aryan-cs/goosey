"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Device = { id: string; code: string; expiresAt: string };
export function BadgeLink() {
  const [challenge, setChallenge] = useState("");
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error("Could not load your account.");
        if (!active) return;
        if (/^[a-f0-9]{64}$/.test(hash)) setChallenge(hash);
        setUser(data.user);
        if (data.user) {
          const result = await fetch("/api/badge/link", { cache: "no-store" });
          const body = await result.json();
          if (!result.ok) throw new Error(body.error?.message || "Could not load badges.");
          if (active) setDevices(body.devices);
        }
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Could not load badges."); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, []);

  async function update(method: "POST" | "DELETE", body: { challenge: string } | { id: string }) {
    setBusy(true);setMessage("");
    try {
      const response = await fetch("/api/badge/link", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || "Could not update this badge.");
      if (method === "POST") { setLinked(true);setMessage(`Linked to @${data.username}. Your badge will update in a few seconds.`); }
      else if ("id" in body) { setDevices((items) => items.filter((device) => device.id !== body.id));setMessage("Badge access revoked."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not update this badge."); }
    finally { setBusy(false); }
  }

  const next = encodeURIComponent(`/badge${challenge ? `#${challenge}` : ""}`);
  return <section className="stacked-form">
    <h1>Link your badge</h1>
    {loading ? <p>Loading your account…</p> : !user ? <><p>Sign in once to use your Goosey balance on your badge.</p><Link className="button button-primary" href={`/login?next=${next}`}>Sign in</Link><Link href={`/signup?next=${next}`}>Create an account</Link></> : <>
      <p>Signed in as <strong>@{user.username}</strong>.</p>
      {challenge && !linked ? <>
        <p>Check that your badge shows <strong>{challenge.slice(0,8).toUpperCase()}</strong>.</p>
        <p>Linking lets this badge’s USB gateway read your balance and submit trades you confirm on the badge. Access expires in seven days and can be revoked here.</p>
        <button className="button button-primary" disabled={busy} onClick={() => void update("POST", { challenge })}>Link this badge</button>
      </> : !linked ? <p>Start the USB gateway and open the link it shows to connect a badge.</p> : null}
      {devices.length > 0 && <><h2>Linked badges</h2>{devices.map((device) => <div key={device.id}><p>{device.code} · expires {new Date(device.expiresAt).toLocaleDateString()}</p><button className="button button-secondary" disabled={busy} onClick={() => void update("DELETE", { id: device.id })}>Revoke {device.code}</button></div>)}</>}
    </>}
    {message && <p role="status">{message}</p>}
    <p>The badge needs its USB gateway running to trade. No password is stored in the shared badge app.</p>
  </section>;
}
