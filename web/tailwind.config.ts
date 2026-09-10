import type {Config} from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // A terminal palette: near-black grounds, one green, one red, one amber.
        // Restraint is the point — a screen a trader trusts is not a screen that decorates.
        ink: {
          980: "#050609",
          950: "#07080c",
          900: "#0b0d13",
          850: "#0f1218",
          800: "#141822",
          700: "#1c212c",
          600: "#2a3140",
          500: "#3d4657",
        },
        edge: "#1a1f2a",
        "edge-hi": "#252c3a",
        txt: {
          hi: "#f2f4f8",
          mid: "#a4adbd",
          lo: "#646d7e",
        },
        up: "#00e39b",
        down: "#ff3d55",
        warn: "#ffb43a",
        floor: "#ff3d55",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", {lineHeight: "1rem"}],
      },
      boxShadow: {
        // Depth comes from a hairline top highlight, not a drop shadow. On a near-black
        // ground a shadow reads as mud; a 1px lighter edge reads as a raised surface.
        panel: "inset 0 1px 0 0 rgba(255,255,255,0.035)",
        "panel-lg":
          "inset 0 1px 0 0 rgba(255,255,255,0.05), 0 1px 2px 0 rgba(0,0,0,0.6)",
        glow: "0 0 24px -6px rgba(0,227,155,0.35)",
        "glow-down": "0 0 24px -6px rgba(255,61,85,0.4)",
      },
    },
  },
  plugins: [],
} satisfies Config;
