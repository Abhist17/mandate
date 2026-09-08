import type {Config} from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // A terminal palette: near-black grounds, one green, one red, one amber.
        // Restraint is the point — a screen a trader trusts is not a screen that decorates.
        ink: {
          950: "#08090b",
          900: "#0c0e12",
          850: "#101319",
          800: "#151922",
          700: "#1d222c",
          600: "#2a3040",
          500: "#3d4455",
        },
        edge: "#232833",
        txt: {
          hi: "#e8eaef",
          mid: "#9aa3b2",
          lo: "#5f6879",
        },
        up: "#2ee6a8",
        down: "#ff4d5e",
        warn: "#ffb340",
        floor: "#ff4d5e",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", {lineHeight: "1rem"}],
      },
    },
  },
  plugins: [],
} satisfies Config;
