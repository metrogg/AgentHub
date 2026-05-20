import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#ffffff',
          elevated: '#f7f7f5',
          hover: '#eeeeec',
        },
        border: {
          DEFAULT: '#27272a',
          subtle: '#1f1f22',
        },
        accent: {
          DEFAULT: '#111111',
          hover: '#2a2a2a',
        },
      },
      fontFamily: {
        sans: ['"Aptos"', '"IBM Plex Sans"', '"Noto Sans SC"', 'ui-sans-serif', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [typography],
}
