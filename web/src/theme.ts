import {
  Badge,
  Button,
  createTheme,
  Drawer,
  type MantineColorsTuple,
  Modal,
  Paper,
  Progress,
  SegmentedControl,
  Table,
  Tabs,
  Tooltip,
} from "@mantine/core";

/*
 * Trainslator's palette comes from the bindery and the copy-editor's desk:
 * paper and blue-black ink, a bookcloth green for actions and progress, and
 * the editor's pencils for status: red for what needs attention, blue for
 * what you decided yourself, ochre for warnings and open questions.
 */

const bookcloth: MantineColorsTuple = [
  "#e8f3ef",
  "#d2e7df",
  "#a6cfbf",
  "#77b59d",
  "#4f9c81",
  "#34846a",
  "#256f58",
  "#1e5547",
  "#174a3c",
  "#0f362b",
];

const redPencil: MantineColorsTuple = [
  "#fcedeb",
  "#f7d5d1",
  "#eeaaa3",
  "#e47d73",
  "#da5a4e",
  "#cf4337",
  "#c2352a",
  "#a62b22",
  "#8a231c",
  "#6c1a15",
];

const bluePencil: MantineColorsTuple = [
  "#ebf1fc",
  "#d3e0f8",
  "#a8c2f0",
  "#7ca3e8",
  "#5688e0",
  "#3c74d6",
  "#2d64c8",
  "#2553a8",
  "#1e4488",
  "#163366",
];

const ochre: MantineColorsTuple = [
  "#fbf3e4",
  "#f5e3c1",
  "#ebc886",
  "#e0ac4c",
  "#d29426",
  "#be8014",
  "#a86a0d",
  "#8c580b",
  "#704609",
  "#553507",
];

/** Cool paper greys in light mode; mirrors ink tones for borders and dimmed text. */
const gray: MantineColorsTuple = [
  "#f6f7f9",
  "#eef0f3",
  "#e2e6ea",
  "#d3d8df",
  "#b8bfc9",
  "#8d96a3",
  "#5e6878",
  "#444d5b",
  "#2c3442",
  "#1b2433",
];

/** Dark mode: a desk at night, never pure black. */
const dark: MantineColorsTuple = [
  "#e4e8ee",
  "#c3cad5",
  "#98a2b3",
  "#6b7586",
  "#3a424f",
  "#2a313b",
  "#20262f",
  "#181d24",
  "#12161c",
  "#0c0f13",
];

export const SERIF = '"Literata Variable", Literata, Georgia, "Times New Roman", serif';
const SANS = '"IBM Plex Sans Variable", "IBM Plex Sans", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace';

export const theme = createTheme({
  colors: {
    bookcloth,
    red: redPencil,
    blue: bluePencil,
    yellow: ochre,
    orange: ochre,
    green: bookcloth,
    gray,
    dark,
  },
  primaryColor: "bookcloth",
  primaryShade: { light: 7, dark: 6 },
  black: "#1b2433",
  white: "#ffffff",
  fontFamily: SANS,
  fontFamilyMonospace: MONO,
  headings: {
    fontFamily: SERIF,
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "2.25rem", lineHeight: "1.15" },
      h2: { fontSize: "1.625rem", lineHeight: "1.2" },
      h3: { fontSize: "1.25rem", lineHeight: "1.3" },
      h4: { fontSize: "1.0625rem", lineHeight: "1.35" },
    },
  },
  fontSizes: {
    xs: "0.75rem",
    sm: "0.8125rem",
    md: "0.875rem",
    lg: "1rem",
    xl: "1.125rem",
  },
  lineHeights: { xs: "1.4", sm: "1.45", md: "1.5", lg: "1.55", xl: "1.6" },
  radius: { xs: "2px", sm: "4px", md: "6px", lg: "10px", xl: "16px" },
  defaultRadius: "sm",
  cursorType: "pointer",
  focusRing: "auto",
  components: {
    Badge: Badge.extend({
      defaultProps: { variant: "light", radius: "sm" },
      styles: { root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 } },
    }),
    Button: Button.extend({
      styles: { root: { fontWeight: 500 } },
    }),
    Paper: Paper.extend({ defaultProps: { radius: "sm" } }),
    Table: Table.extend({
      defaultProps: { verticalSpacing: 8, horizontalSpacing: "sm" },
      styles: {
        th: {
          fontWeight: 500,
          fontSize: "var(--mantine-font-size-xs)",
          color: "var(--mantine-color-dimmed)",
        },
      },
    }),
    Tabs: Tabs.extend({
      styles: { tab: { fontWeight: 500, fontSize: "var(--mantine-font-size-md)" } },
    }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { size: "xs" } }),
    Progress: Progress.extend({ defaultProps: { size: "xs", radius: "xl" } }),
    Tooltip: Tooltip.extend({ defaultProps: { openDelay: 250, withArrow: true } }),
    Modal: Modal.extend({
      styles: {
        title: { fontFamily: SERIF, fontWeight: 600, fontSize: "1.25rem" },
      },
    }),
    Drawer: Drawer.extend({
      styles: {
        title: { fontFamily: SERIF, fontWeight: 600, fontSize: "1.25rem" },
      },
    }),
  },
});
