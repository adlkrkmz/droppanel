import type { Config } from "tailwindcss"

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono:    ["'JetBrains Mono'", "monospace"],
        display: ["'Syne'", "sans-serif"],
        body:    ["'DM Sans'", "sans-serif"],
      },
      colors: {
        bg:      "#0a0a0a",
        surface: "#111111",
        border:  "#1e1e1e",
        muted:   "#2a2a2a",
        dim:     "#555555",
        text:    "#e8e8e8",
        sub:     "#888888",
        accent:  "#00ff88",
        warn:    "#ffaa00",
        danger:  "#ff4455",
        info:    "#3399ff",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.2" },
        },
      },
      animation: {
        "fade-in":   "fade-in 0.3s ease forwards",
        "pulse-dot": "pulse-dot 1.4s ease infinite",
      },
    },
  },
  plugins: [],
}

export default config
