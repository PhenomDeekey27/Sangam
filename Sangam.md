# DESIGN.md — Sangam

**Sangam** (Sanskrit/Tamil: *confluence, meeting point*): two people, two languages, one live conversation.
Alternatives if you want another name: **Tandem**, **Paalam** (Tamil for "bridge").

Direction: premium, voice-first, calm. The **Voice Bridge** (an arch connecting two speakers) is the signature element.

## 1. Semantic color tokens

Define as CSS variables on `:root` (light) and `.dark` (dark). Components use tokens only.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F6F3EC` | `#0C0B1A` | App background |
| `--surface` | `#FFFFFF` | `#171631` | Cards, tiles, transcript rows |
| `--ink` | `#1B1A2E` | `#F3F1FF` | Primary text |
| `--mute` | `#5B5A70` | `#A9A7C4` | Translated / secondary text |
| `--line` | `#D9D4C7` | `#34325A` | Borders, idle bars, dotted bridge |
| `--speaker-a` (You) | `#C2410C` | `#FBA94B` | Your tile, bars, ripples |
| `--on-a` | `#FFFFFF` | `#1A1030` | Text on speaker-a fill |
| `--glow-a` | `rgba(194,65,12,.16)` | `rgba(251,169,75,.22)` | Active tile halo |
| `--speaker-b` (Partner) | `#0F766E` | `#2DD4BF` | Partner tile, bars, ripples |
| `--on-b` | `#FFFFFF` | `#04201C` | Text on speaker-b fill |
| `--glow-b` | `rgba(15,118,110,.16)` | `rgba(45,212,191,.22)` | Active tile halo |
| `--bridge` | `#4F46E5` | `#A5B4FC` | Translation flow dots, "live" markers |

Warm (orange) vs cool (teal) differ in **lightness as well as hue**, so speakers stay distinguishable for color-blind users.

Fonts: **Bricolage Grotesque** (display, 500/700) + **Inter Tight** (UI, 400–600).

## 2. Speaker-state signals (never color alone)

| State | Tile | Badge text | Waveform | Bridge |
|---|---|---|---|---|
| Speaking | 2px colored border + 6px glow halo, filled badge | "Speaking" | 11 bars, full height, staggered | Dots flow speaker → listener, pill "Translating X → Y" |
| Listening / idle | Neutral border | "Listening" | Low, slow "breathing" bars | Static dotted arch |
| Waiting | Neutral | "Waiting for partner" | Flat | Static |
| Interrupted | Border dashed, glow off | "Interrupted" | Bars collapse to flat in 150ms | Dots stop |
| Disconnected / mic denied / error | Danger border + inline message | Text + icon | Flat | Arch broken (gap), text explains |

## 3. Animations

All CSS/SVG, no dependency.

| Name | What | Timing |
|---|---|---|
| `ring` | Two concentric rings expand from avatar (scale 1→2, opacity .7→0), second offset by half a cycle | 2.4s ease-out, infinite |
| `bar` | Waveform bar `scaleY` .15→1→.15; `nth-child` delays (-.1s, -.2s, -.45s, -.65s) break uniformity | .9s ease-in-out, infinite |
| `breathe` | Idle bars `scaleY` .2↔.38 | 3s ease-in-out, infinite |
| `flow` | 5 dots travel the bridge arch via `offset-path`, fading in/out at ends; direction reverses with the active speaker (`animation-direction: reverse`) | 2.2s linear, staggered .44s |
| `blink` | Status dot / "live" marker opacity pulse | 1s ease-in-out (live label: 1.1s steps) |

Production notes: drive `.on` / idle classes from real speaker state; drive bar heights from `AnalyserNode` RMS later (replace the CSS loop, keep the same tokens).

## 4. Reduced motion

`@media (prefers-reduced-motion: reduce)`: all animations off. Active speaker keeps border + glow + "Speaking" badge, bars freeze at 70% height, and one bridge dot rests at the arch midpoint. No information is lost.

## 5. Accessibility

- 44px minimum touch targets (mic button 56px); visible focus rings on every control.
- Status changes (speaking, translating, partner left) announced via an `aria-live="polite"` region.
- Decorative SVG `aria-hidden`; icon-only buttons have `aria-label`.
- Text contrast ≥ 4.5:1 in both themes (the `speaker-a` and `speaker-b` text colors were darkened in light mode for this).

## 6. Layout (desktop 1200 × 760; mobile 360 stacks vertically)

Header (logo, room code, connection, theme) → stage (tile · bridge · tile) → transcript (original + translation per entry) → composer (mic, stop playback, interrupt, text fallback, send). On mobile the bridge rotates to a short vertical arch between stacked tiles, and the composer is sticky above the keyboard.
