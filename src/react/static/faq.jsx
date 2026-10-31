// FAQ page (faq.html): sections of questions in shadcn Accordions
import * as React from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { mountStaticPage, PROSE, Section, StaticPage } from './StaticPage.jsx';

function Faq() {
  return (
    <StaticPage title={"FAQ"} sub={"Everything Questtick does, from creating an account to reading your weekly AI journal summary — with a focus on how your data and keys are protected."}>
      <Section title={"Getting started"}>
        <Accordion type="multiple" defaultValue={["0-0"]}>
          <AccordionItem value="0-0">
            <AccordionTrigger>What is Questtick?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Questtick is a crypto trading assistant for Binance Futures altcoins. It tracks live price/volume across the market, lets you build a daily watchlist ("briefing"), and keeps a trading journal with AI-assisted weekly reviews.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="0-1">
            <AccordionTrigger>How do I sign up?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Sign up with an email and password (minimum 8 characters), or with Google. Email/password accounts must verify their email before the account is fully active — we send a verification link automatically.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="0-2">
            <AccordionTrigger>Can I try it without creating an account?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Yes — "Try without account" puts you in demo mode. You can browse the main board, Gainers, Full View, the liquidity panel and search freely, and draw levels/rays (they just stay local to your browser instead of syncing).</p>
              <p>What's gated behind sign-up: AI coin analysis, saving alerts, the briefing watchlist, the trading journal, notifications, and Telegram/Binance integrations — anything that needs to be remembered between sessions or sent to you.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Account & security"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="1-0">
            <AccordionTrigger>How are my password and login protected?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Passwords are hashed with scrypt before storage — we never store your plain password. Sign-in and sign-up are rate-limited (max 5 sign-in attempts and 3 sign-up attempts per minute per source) to slow down brute-force and credential-stuffing attempts.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="1-1">
            <AccordionTrigger>How long does my session last?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Sessions last 30 days and are tied to a secure cookie. Changing your password or confirming an email change revokes your other active sessions automatically.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="1-2">
            <AccordionTrigger>What happens if I get a "password changed" email I didn't request?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Every password change triggers a notification email with a "this wasn't me" link. Clicking it immediately revokes all sessions on the account, so you can act before anyone with access to your inbox can lock you out.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="1-3">
            <AccordionTrigger>How does changing my email work?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Changing email is a verified, multi-step flow: first you confirm your identity with your password, then we email a confirmation code to both your old and new address, and only after that code is entered does the email actually change. This prevents someone who only has temporary access to your session from silently taking over the account.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="1-4">
            <AccordionTrigger>Is there two-factor authentication?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Not yet — there's no TOTP app or SMS-style second factor at the moment. Account security currently relies on password verification plus the email-confirmation step on sensitive changes.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="1-5">
            <AccordionTrigger>What happens when I delete my account?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Account deletion is permanent and removes your stored levels, alerts, drawn trend lines, briefing history, journal entries, trading limits, AI summaries, notifications, Telegram link, Binance API keys, avatar, and timezone setting from our servers immediately.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Integrations (Telegram & Binance)"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="2-0">
            <AccordionTrigger>What is the Telegram integration for?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Linking Telegram lets Questtick send you alerts, your weekly briefing review, and journal reminders directly in chat.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="2-1">
            <AccordionTrigger>Is it safe to connect my Binance API key?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Your key is only used to read account data (balances, fills) for journal PnL and is never used to place orders. Before saving, we validate the key directly against Binance and reject it unless it is read-only — any key with trading or withdrawal permissions enabled is refused. Once saved, the key and secret are encrypted with AES-256-GCM using a key derived from our server secret; they are never stored or transmitted in plain text.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="2-2">
            <AccordionTrigger>Can Questtick withdraw funds or place trades with my Binance key?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>No. Keys with any permission beyond read-only are rejected at save time, so even if our systems were compromised, the key itself cannot move funds or place orders on Binance's side.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="2-3">
            <AccordionTrigger>Can I remove my Binance key or Telegram link later?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Yes, both can be disconnected at any time from the Integrations tab of your account settings, and removing them deletes the stored credentials.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Main board & Gainers"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="3-0">
            <AccordionTrigger>What do I see on the main board ("Tear")?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Coin cards filtered by 24h trading volume (you can raise the bar to $50M or $100M), each with a live price chart, 24h change, NATR volatility and volume, updated in real time over a WebSocket connection.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-1">
            <AccordionTrigger>What's "Gainers"?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>The same card layout, but switched to showing the top movers by 24h price change instead of filtering by volume — useful for spotting whatever is moving the most right now, regardless of size.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-2">
            <AccordionTrigger>What happens when I open a coin (Full View)?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Clicking a card, a search result, or a briefing entry opens Full View: a large interactive chart with drawing tools, the liquidity panel, and the briefing drawer for that coin, all in one screen.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-3">
            <AccordionTrigger>How do I draw price levels and trend lines?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Right-click the chart to drop a horizontal level at that price. Hold Ctrl and right-click (or Ctrl-click, on trackpads) to draw a ray/trend line through that point instead. Both can be dragged to adjust and right-clicked again to remove. They're tied to the symbol and timeframe, and sync to your account if you're signed in.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-4">
            <AccordionTrigger>How do price alerts work?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Hold Shift and right-click the chart to set an alert at that price. When the price touches it, you get an in-app toast and notification, plus a Telegram message if you've linked your bot. Saving and syncing alerts requires an account.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-5">
            <AccordionTrigger>What's In play?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>A grid of live charts of the coins moving the most right now (the grid icon in the header, /grid). Pick the period (5m–3h) and what to sort by — range, volume or trades against the coin's norm, their growth, or closeness to the day's high / low. Pin a coin to keep it on the grid, star it to add it to your watchlist. Built to stay open on a TV for hours.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-6">
            <AccordionTrigger>What's the liquidity panel?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Inside Full View, the orderbook icon opens a panel with live spread, bid/ask depth, buy/sell aggression, and a trade tape — built directly from Binance's order book and trade stream, useful for reading short-term support and pressure.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="3-7">
            <AccordionTrigger>How does search work?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>The search button opens a quick lookup by symbol; results are ranked by match and 24h change, and selecting one opens Full View for that coin.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Briefing"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="4-0">
            <AccordionTrigger>What is the briefing?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Your daily watchlist: add coins you're tracking for a given date, attach notes, and mark each one as watching, traded, skipped, or missed once the day plays out.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="4-1">
            <AccordionTrigger>What's the weekly report?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Every Sunday evening (in your account's timezone), Questtick gathers your week's briefing entries and notes, sends them to Gemini for a short review of recurring patterns in your decision-making, and returns 2–3 concrete rules to apply the following week. The report is delivered as both a Telegram message and an in-app notification.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Trading journal"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="5-0">
            <AccordionTrigger>Where do the volume/drawdown numbers in the morning entry come from?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>From Account → Profile → Trading limits, where you set your daily working volume, allowed drawdown per trade, and max trades per day. The morning journal entry displays these live, so updating the numbers in settings immediately changes what you see there — no need to re-enter them each day.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="5-1">
            <AccordionTrigger>What do I fill in each day?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>A short morning entry (your state, the day's plan, coins you expect to watch, what could trigger a bad decision, plus your configured volume/drawdown/trade-count limits) and a short evening entry (whether you followed the plan, trade count, whether you kept your stop, and which trading-error patterns showed up). You can also mark a day as skipped if you didn't trade.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="5-2">
            <AccordionTrigger>Where does my PnL come from?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>If you've connected a read-only Binance API key, your daily PnL is calculated automatically from your account's fills and shown alongside your journal entries — you don't enter it manually.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="5-3">
            <AccordionTrigger>What does the AI journal summary do?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Over a 1-week, 2-week or 1-month range you can request an AI summary. Questtick sends Gemini your briefing entries (coins, notes, real PnL), your full morning and evening journal answers for each day — mood, plan, discipline checks, which trigger fired — and your current trading limits, then asks it to compare days against each other and surface patterns: where plan and discipline drifted from the result, repeating triggers, and whether your volume/drawdown/trade-count limits were respected.</p>
              <p>For the 1-month range, days are grouped into weekly summaries (PnL, trade count, limit violations, trigger tally) instead of being listed individually, so Gemini compares weeks and spots a trend rather than getting buried in 30 days of detail. The result is a short written review, 300–450 words.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="5-4">
            <AccordionTrigger>Can I export my journal?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Yes, journal history can be exported as CSV for any date range.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"AI coin analysis (Gemini)"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="6-0">
            <AccordionTrigger>What does the "Analyze" button do?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>It sends the coin's current price, volume and volatility data along with recent news headlines to Gemini, which returns a short read on the catalyst behind the move and a signal (bullish / caution / neutral) — for example flagging that a delisting headline is not a bullish catalyst, while a Binance listing is.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="6-1">
            <AccordionTrigger>Is the analysis financial advice?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>No — it's a fast summary of the public news and data behind a price move, meant to save you a search, not to recommend a trade.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Notifications"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="7-0">
            <AccordionTrigger>What shows up in the bell icon?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Price-alert triggers, your weekly briefing report, and reminders to fill in your journal before the European session opens. Each notification can be marked read individually or all at once, and the list can be cleared from the same dropdown.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="7-1">
            <AccordionTrigger>How long are notifications kept?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Notifications are kept for 30 days and then expire automatically.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title={"Data & privacy"}>
        <Accordion type="multiple" defaultValue={[]}>
          <AccordionItem value="8-0">
            <AccordionTrigger>Where is my data stored?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Account, session and journal records live in our SQLite database; fast-changing data like your briefing, levels, alerts and notifications live in Redis. Binance API keys are the only credentials stored, and they're always encrypted at rest.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="8-1">
            <AccordionTrigger>Who can access my account data?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>Every endpoint that reads or writes your data (analysis, levels, briefing, journal, account, notifications) requires a valid session — there is no way to read another user's data through the API.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="8-2">
            <AccordionTrigger>Where can I read the full Privacy Policy and Terms of Service?</AccordionTrigger>
            <AccordionContent className={PROSE}>
              <p>The <a href="/privacy">Privacy Policy</a> covers exactly what we collect, why, who we share it with, and how to get it deleted. The <a href="/terms">Terms of Service</a> cover acceptable use and the "not financial advice" disclaimer for AI-generated content.</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
    </StaticPage>
  );
}

mountStaticPage(Faq);
