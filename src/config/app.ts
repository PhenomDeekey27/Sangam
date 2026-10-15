/**
 * Brand and copy for the application shell. Used by route metadata and,
 * later, the header and landing screen.
 */
export const siteConfig = {
  name: "Sangam",
  tagline: "Two people, two languages, one live conversation.",
  description:
    "Sangam is a real-time, two-person conversation app: each person speaks their own language and hears the other in theirs.",
} as const;

export type SiteConfig = typeof siteConfig;
