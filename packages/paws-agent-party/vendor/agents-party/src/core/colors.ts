/**
 * Participant colors — assigned once at join, stored in the party's participants table, stable across every client
 * (CLI, package web, the site). `host` is always black; everyone else gets the next color from a fixed palette in join
 * order (wrapping when the party outgrows it). Clients map the names onto their own theme's swatches.
 */

export const HOST_COLOR = 'black'

export const PARTICIPANT_COLORS = ['blue', 'green', 'orange', 'violet', 'pink', 'teal', 'red', 'amber'] as const

export const pickParticipantColor = (existingCount: number): string =>
  PARTICIPANT_COLORS[existingCount % PARTICIPANT_COLORS.length] as string
