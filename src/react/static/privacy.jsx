// Privacy Policy page (privacy.html)
import * as React from 'react';
import { mountStaticPage, PROSE, Section, StaticPage } from './StaticPage.jsx';

function Privacy() {
  return (
    <StaticPage title={"Privacy Policy"} sub={"Last updated: June 22, 2026. Questtick is operated by an individual developer (\"we\", \"us\"). This page explains what data we collect, why, and how to get it deleted."}>
      <Section title={"What we collect"} className={PROSE}>
        <ul>
        <li><strong>Account:</strong> email and password (hashed with scrypt — we never store or see your plain password), or your name/email from Google if you sign in with Google.</li>
        <li><strong>Profile settings:</strong> avatar choice, timezone, and the daily trading limits you configure (working volume, drawdown per trade, max trades per day).</li>
        <li><strong>Binance API key</strong> (optional): only read-only keys are accepted — we reject any key with trading or withdrawal permission at save time. Stored encrypted (AES-256-GCM) and used solely to read your balances/fills for journal PnL.</li>
        <li><strong>Telegram chat ID</strong> (optional): set when you link our bot, used to deliver price alerts, your weekly briefing report, and journal reminders.</li>
        <li><strong>Your content:</strong> watchlist ("briefing") entries — coin symbols, dates, your notes and status — plus your trading journal entries (morning/evening check-ins, mood ratings, free-text notes, trade counts) and any price levels, alerts or trend lines you draw on charts.</li>
        <li><strong>Session data:</strong> a secure session cookie, and your IP address/browser user agent at sign-in, kept for security purposes for the life of the session (30 days).</li>
        <li><strong>Basic usage analytics:</strong> aggregated, cookie-less page performance data via Vercel Analytics/Speed Insights — we don't use this to identify you individually.</li>
        </ul>
      </Section>
      <Section title={"How we use it"} className={PROSE}>
        <ul>
        <li>To run the product: sync your watchlist, levels, alerts and journal across your devices, and show you your own trading data.</li>
        <li>To generate AI analysis: when you request a coin analysis, a weekly briefing report, or a journal summary, the relevant text (coin/market data, your briefing notes, your journal entries) is sent to Google's Gemini API to produce that analysis. We do not send your email, password, or Binance/Telegram credentials to Gemini.</li>
        <li>To deliver notifications you've opted into (price alerts, weekly report, journal reminders) via Telegram and in-app notifications.</li>
        </ul>
        <p>We do not sell your data, and we do not use it for advertising.</p>
      </Section>
      <Section title={"Who we share it with"} className={PROSE}>
        <p>We use the following service providers ("sub-processors") to run Questtick. Each only receives the minimum data needed for its purpose:</p>
        <ul>
        <li><strong>Google</strong> — Gemini API (text you submit, for AI analysis) and Google Sign-In (if you use it).</li>
        <li><strong>Binance</strong> — only if you connect a read-only API key, to fetch your balances/fills.</li>
        <li><strong>Telegram</strong> — only if you link our bot, to deliver messages to the chat you started with it.</li>
        <li><strong>Upstash</strong> (Redis hosting) and our VPS provider — store your data as part of running the backend.</li>
        <li><strong>Resend</strong> — sends transactional emails (password reset, email verification, email-change confirmation). No marketing emails.</li>
        <li><strong>Vercel</strong> — hosts the frontend and provides the anonymized analytics described above.</li>
        </ul>
        <p>We do not sell or rent your data to third parties, and we don't share it for marketing purposes.</p>
      </Section>
      <Section title={"Data retention"} className={PROSE}>
        <ul>
        <li>Account data, journal entries, watchlist history, levels and alerts are kept until you delete them or delete your account.</li>
        <li>In-app notifications expire automatically after 30 days.</li>
        <li>Cached AI summaries are kept until the underlying data changes or you regenerate/delete them.</li>
        </ul>
      </Section>
      <Section title={"Your rights"} className={PROSE}>
        <ul>
        <li><strong>Export:</strong> download your full journal history as a CSV file at any time.</li>
        <li><strong>Disconnect:</strong> remove your Binance API key or Telegram link at any time without deleting your whole account.</li>
        <li><strong>Delete:</strong> delete your account from Account settings → Security. This is immediate and permanent, and removes your watchlist history, journal entries, price levels/alerts/trend lines, AI summaries, trading limits, Telegram link, Binance API key, avatar and timezone setting from our servers.</li>
        <li>If you're in the EU/UK or another jurisdiction with data protection law, you may also have rights to access, correct, restrict, or port your data — contact us below to exercise them.</li>
        </ul>
      </Section>
      <Section title={"Security"} className={PROSE}>
        <ul>
        <li>Passwords are hashed with scrypt; we never store them in plain text.</li>
        <li>Binance API keys are encrypted at rest (AES-256-GCM) and we only accept read-only keys.</li>
        <li>Sign-in and sign-up are rate-limited to slow down brute-force and credential-stuffing attempts.</li>
        <li>Every password change and email change requires identity confirmation and notifies you, with a one-click "this wasn't me" option that revokes all active sessions.</li>
        </ul>
      </Section>
      <Section title={"Cookies"} className={PROSE}>
        <p>We use one essential session cookie required to keep you signed in — it's not used for tracking or advertising. We don't use third-party advertising or cross-site tracking cookies.</p>
      </Section>
      <Section title={"Age requirement"} className={PROSE}>
        <p>Questtick involves cryptocurrency trading information and is not intended for use by anyone under 18.</p>
      </Section>
      <Section title={"Changes to this policy"} className={PROSE}>
        <p>We may update this policy as the product changes. The "last updated" date at the top will reflect the latest revision; material changes will be highlighted via an in-app notice.</p>
      </Section>
      <Section title={"Contact"} className={PROSE}>
        <p>Questions about this policy or your data — including deletion or access requests — can be sent to <a href="mailto:kohalovd@gmail.com">kohalovd@gmail.com</a>.</p>
      </Section>
    </StaticPage>
  );
}

mountStaticPage(Privacy);
