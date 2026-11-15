import type { AppFault } from "../app-emulator.js";
import { relativeDate, relativeTime } from "../app-emulator.js";
import type { FileSeed } from "../files.js";
import { FilesEmulator, fileId } from "../files.js";
import type { MailThreadSeed } from "../mail.js";
import { MailEmulator } from "../mail.js";
import type { PageSeed } from "../notes.js";
import { NotesEmulator } from "../notes.js";

/**
 * One fictional furniture and interiors studio across mail, files and notes, so a task can cross
 * services. Every person, company and address is invented; domains use the reserved .example TLD.
 * Times are relative to the service clock, so recent mail stays recent whenever it runs.
 */
export const STUDIO_FIXTURE_VERSION = "studio-v2";

export const SAM = { name: "Sam Okafor", email: "sam@haldenmoss.example" };
const LEO = "Leo Brandt <leo@haldenmoss.example>";
const MARTA = "Marta Kovács <marta@haldenmoss.example>";
const AISHA = "Aisha Bello <aisha@haldenmoss.example>";
export const DANA = "Dana Whitfield <dana.whitfield@juniperrow.example>";
const TOMAS = "Tomás Ruiz <t.ruiz@ostrava-timber.example>";
const INES = "Ines Calder <ines@calderhardware.example>";
const SAM_FROM = `${SAM.name} <${SAM.email}>`;
const FILES_URL = "https://files.example.com";

const DAY = 86_400_000;
/** "Thursday 20 November", as people write dates in mail. */
export function spokenDate(now: Date, daysFromNow: number) {
  return new Date(now.getTime() + daysFromNow * DAY).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

const fileUrl = (key: string, kind: "d" | "sheets/d" = "d") =>
  `${FILES_URL}/${kind}/${fileId(key)}`;

/** Dates the cases grade against, from the same clock as the seeds. */
export function studioFacts(now: Date) {
  return {
    ostravaNewEta: relativeDate(now, 11),
    lumenEta: relativeDate(now, 4),
    proposalV3Url: fileUrl("juniper-proposal-v3"),
    proposalV2Url: fileUrl("juniper-proposal-v2"),
    proposalV3Total: "EUR 41,250",
    proposalV2Total: "EUR 38,400",
    budget2027Id: fileId("budget-2027"),
  };
}

const SIGNATURE = "\n\n--\nSam Okafor\nOperations Lead · Halden & Moss\n+44 20 7946 0321";

function threads(now: Date): MailThreadSeed[] {
  const t = (days: number, time?: string) => relativeTime(now, days, time);
  const facts = studioFacts(now);
  const hand: MailThreadSeed[] = [
    {
      key: "juniper-update",
      subject: "Lobby seating — updated proposal?",
      labels: ["Clients"],
      messages: [
        {
          from: DANA,
          to: [SAM_FROM],
          cc: [LEO],
          date: t(2, "08:47"),
          unread: true,
          body: `Hi Sam,\n\nThanks again for the walk-through on Tuesday — the team loved the sample panels.\n\nLeo mentioned you were revising the proposal with the walnut finish we talked about. Could you send me the updated version with the total including delivery? I'd like to take it to our budget meeting on Monday.\n\nBest,\nDana\n\nDana Whitfield\nFacilities Manager · Juniper Row Hotel\n14 Canal Street, Leeds`,
        },
      ],
    },
    {
      key: "juniper-v2",
      subject: "Juniper Row lobby — proposal v2",
      labels: ["Clients"],
      messages: [
        {
          from: SAM_FROM,
          to: [DANA],
          date: t(34, "15:02"),
          body: `Hi Dana,\n\nAs promised, here's the revised proposal with the oak option: ${facts.proposalV2Url}\n\nThe total comes to EUR 38,400 including delivery. Happy to walk through it whenever suits.${SIGNATURE}`,
        },
        {
          from: DANA,
          to: [SAM_FROM],
          date: t(33, "10:15"),
          body: "Thanks Sam, I'll review it with our GM and come back to you. We may want to look at a darker wood.\n\nDana",
        },
      ],
    },
    {
      key: "leo-v3",
      subject: "v3 for Juniper is in the folder",
      messages: [
        {
          from: LEO,
          to: [SAM_FROM],
          date: t(1, "17:31"),
          body: "Hey Sam — updated the Juniper proposal with the walnut slats and the two extra lounge chairs Dana asked about. It's in Clients › Juniper Row Hotel as v3. Didn't touch the delivery line. Shout if the numbers look off.\n\nL",
        },
      ],
    },
    {
      key: "ostrava-delay",
      subject: "PO-4471 — revised dispatch date",
      labels: ["Suppliers"],
      messages: [
        {
          from: TOMAS,
          to: [SAM_FROM],
          date: t(2, "11:20"),
          unread: true,
          body: `Dear Sam,\n\nI'm sorry to let you know that order PO-4471 (oak boards, 32 mm, 48 pcs) is delayed. One of our kilns failed an inspection and the batch needs another four days of drying.\n\nThe new delivery date is ${spokenDate(now, 11)}. Everything else on the order is unchanged. Apologies for the inconvenience.\n\nKind regards,\nTomás Ruiz\nSales · Ostrava Timber s.r.o.`,
        },
      ],
    },
    {
      key: "calder-delivered",
      subject: "Delivery confirmation — PO-4465",
      labels: ["Suppliers"],
      messages: [
        {
          from: INES,
          to: [SAM_FROM],
          cc: [AISHA],
          date: t(1, "11:05"),
          body: "Hi Sam,\n\nConfirming PO-4465 (240 × brushed brass drawer pulls, 120 × soft-close hinges) was delivered to your workshop at 10:40 this morning, signed for by A. Bello.\n\nInvoice to follow.\n\nInes\nCalder Hardware",
          attachments: [{ filename: "POD-PO-4465.pdf", mimeType: "application/pdf", size: 48_211 }],
        },
      ],
    },
    {
      key: "lumen-shipped",
      subject: "Your order PO-4480 has shipped",
      labels: ["Suppliers"],
      messages: [
        {
          from: "Lumen Glassworks <dispatch@lumenglass.example>",
          to: [SAM.email],
          date: t(3, "06:58"),
          body: `Good news — your order is on its way.\n\nOrder: PO-4480\nItems: 6 × smoked glass table tops, 900 mm\nCarrier: SwiftParcel Freight\nTracking: SPF-77310-2291\nEstimated delivery: ${spokenDate(now, 4)}\n\nThis is an automated message from Lumen Glassworks.`,
        },
      ],
    },
    {
      key: "felt-colour",
      subject: "PO-4476 – colour confirmation needed",
      labels: ["Suppliers"],
      messages: [
        {
          from: "Orders <orders@feltandfibre.example>",
          to: [SAM.email],
          date: t(3, "13:40"),
          body: "Hello,\n\nBefore we cut your order PO-4476 (wool felt panels), please confirm the colour: our records show both 'Moss 07' and 'Moss 09'. We'll hold production until we hear back.\n\nThanks,\nFelt & Fibre order desk",
        },
      ],
    },
    {
      key: "ostrava-news",
      subject: "Autumn price list & kiln capacity update",
      labels: ["CATEGORY_PROMOTIONS"],
      messages: [
        {
          from: "Ostrava Timber <news@ostrava-timber.example>",
          to: [SAM.email],
          date: t(3, "07:00"),
          body: "Our autumn price list is here. Oak prices rise 3% from 1 December. Across the industry, kiln capacity is tight this season — order early to avoid delays.\n\nYou're receiving this because you're a trade customer. Unsubscribe any time.",
        },
      ],
    },
    {
      key: "calder-old",
      subject: "Delivery confirmation — PO-4419",
      labels: ["Suppliers"],
      messages: [
        {
          from: INES,
          to: [SAM_FROM],
          date: t(20, "09:12"),
          body: "Hi Sam, PO-4419 (black steel brackets) delivered this morning. Ines",
        },
      ],
    },
    {
      key: "marta-budget",
      subject: "FY2027 budget — first draft",
      labels: ["Finance"],
      messages: [
        {
          from: MARTA,
          to: [SAM_FROM, LEO],
          date: t(1, "19:04"),
          body: `Hi both,\n\nFirst draft of next year's budget is here: ${FILES_URL}/sheets/d/${facts.budget2027Id}\n\nCan you look at the marketing line before Thursday's leadership call? I've moved some of the trade-show money into online.\n\nMarta`,
        },
      ],
    },
    {
      key: "kestrel-booths",
      subject: "Kestrel Coworking — phone booth acoustics",
      labels: ["Clients"],
      messages: [
        {
          from: "Owen Price <owen@kestrelcowork.example>",
          to: [SAM_FROM],
          date: t(6, "14:22"),
          body: "Sam, the two booths on level 2 still carry sound from the café. Is there an upgrade to the door seals we can do before the January relaunch?\n\nOwen",
        },
        {
          from: SAM_FROM,
          to: ["Owen Price <owen@kestrelcowork.example>"],
          date: t(5, "09:10"),
          body: `Hi Owen, yes — Leo will spec heavier seals and a felt liner. I'll send a quote this week.${SIGNATURE}`,
        },
      ],
    },
    {
      key: "aisha-lunch",
      subject: "Studio lunch Friday?",
      messages: [
        {
          from: AISHA,
          to: ["team@haldenmoss.example"],
          date: t(3, "12:01"),
          body: "Thinking of ordering from the Lebanese place on Friday at 12:30. Reply with your order by Thursday!",
        },
      ],
    },
  ];
  const fillers: MailThreadSeed[] = [];
  const newsletter = [
    [
      "Interiors Weekly <news@interiorsweekly.example>",
      "This week: hospitality lobbies that work hard",
    ],
    ["Workshop Supply Co. <deals@workshopsupply.example>", "20% off abrasives this weekend"],
    ["Interiors Weekly <news@interiorsweekly.example>", "Material of the month: cork"],
    ["Design Fair Leeds <hello@designfairleeds.example>", "Exhibitor applications close soon"],
  ];
  fillers.push(
    ...newsletter.map(([from, subject], i) => ({
      key: `newsletter-${i}`,
      subject: subject!,
      labels: ["CATEGORY_PROMOTIONS"],
      messages: [
        {
          from: from!,
          to: [SAM.email],
          date: t(1 + i * 2, "06:30"),
          unread: i % 2 === 0,
          body: `${subject}. Read the full issue online.\n\nUnsubscribe · Manage preferences`,
        },
      ],
    })),
  );
  fillers.push(
    ...["2026-0412", "2026-0398", "2026-0377"].map((invoice, i) => ({
      key: `receipt-${i}`,
      subject: `Your receipt from CloudBooks #${invoice}`,
      labels: ["Receipts", "CATEGORY_UPDATES"],
      messages: [
        {
          from: "CloudBooks Billing <billing@cloudbooks.example>",
          to: [SAM.email],
          date: t(7 + i * 30, "03:14"),
          body: `Receipt #${invoice}\nTeam plan, 5 seats — GBP 60.00\nPaid with card ending 4417.`,
        },
      ],
    })),
  );
  const misc: Array<[string, string, number, string]> = [
    [
      "Swift Parcel <noreply@swiftparcel.example>",
      "Your parcel SP-55102 was delivered",
      9,
      "Your parcel SP-55102 was left at reception and signed for by BELLO.\n\nRate your delivery: 1 2 3 4 5",
    ],
    [
      "Calendar <calendar@haldenmoss.example>",
      "Invitation: Leadership call (Thursday 10:00)",
      2,
      "Marta Kovács invited you to Leadership call.\nThursday 10:00–11:00 (UK time)\nAgenda: FY2027 budget, hiring, trade shows.\n\nYes · Maybe · No",
    ],
    [
      AISHA,
      "Holiday cover rota",
      8,
      "Hi all, rota for 22 Dec–2 Jan is in the shared calendar. Sam, you're on the 29th and 30th — shout if that doesn't work.\n\nAisha",
    ],
    [
      LEO,
      "Sample panels for Marlowe Residence",
      12,
      "Priya wants to see terracotta and warm oak side by side. I'll bring both panels to the site visit on Wednesday.",
    ],
    [
      "Priya Nair <priya@marloweresidence.example>",
      "Re: kitchen stools",
      15,
      "We loved option two! Could the seat be 5 cm lower? Our counter is 88 cm.\n\nPriya",
    ],
    [
      "IT Desk <it@haldenmoss.example>",
      "Password expiry reminder",
      10,
      "Your studio account password expires in 7 days. Change it from the account page.",
    ],
    [
      MARTA,
      "Q3 numbers",
      40,
      "Q3 closed slightly ahead of plan: revenue up 6% on Q2, materials 2% over. Full pack is in Finance.",
    ],
    [
      "Brightline Lighting <sales@brightline.example>",
      "Quote BL-2207 for pendant lights",
      18,
      "Please find our quote BL-2207 attached: 12 × opal pendants, GBP 2,940 ex VAT, 3-week lead time. Valid until month end.",
    ],
  ];
  fillers.push(
    ...misc.map(([from, subject, days, body], i) => ({
      key: `misc-${i}`,
      subject,
      labels: from.includes("haldenmoss") ? [] : ["CATEGORY_UPDATES"],
      messages: [{ from, to: [SAM_FROM], date: t(days, `${8 + i}:${10 + i * 5}`), body }],
    })),
  );
  return [...hand, ...fillers];
}

function files(now: Date): FileSeed[] {
  const t = (days: number, time?: string) => relativeTime(now, days, time);
  const team = (role: "writer" | "reader" = "writer") =>
    ["leo@haldenmoss.example", "marta@haldenmoss.example", "aisha@haldenmoss.example"].map(
      (email) => ({ email, role }),
    );
  const folder = (
    key: string,
    name: string,
    parent?: string,
    access: "owner" | "reader" = "owner",
  ): FileSeed => ({
    key,
    name,
    kind: "folder",
    ...(parent ? { parent } : {}),
    owner: access === "owner" ? SAM.email : "leo@haldenmoss.example",
    access,
    modified: t(60),
    sharedWith: team(),
  });
  return [
    folder("clients", "Clients"),
    folder("juniper", "Juniper Row Hotel", "clients"),
    folder("kestrel", "Kestrel Coworking", "clients"),
    folder("marlowe", "Marlowe Residence", "clients"),
    folder("suppliers", "Suppliers"),
    folder("finance", "Finance"),
    folder("templates", "Templates"),
    folder("brand", "Brand", undefined, "reader"),
    {
      key: "juniper-proposal-v2",
      name: "Juniper Row – Lobby Proposal v2",
      kind: "document",
      parent: "juniper",
      owner: SAM.email,
      access: "owner",
      modified: t(34, "14:40"),
      sharedWith: [...team(), { email: "dana.whitfield@juniperrow.example", role: "commenter" }],
      content:
        "# Juniper Row Hotel — Lobby seating proposal (v2)\n\nPrepared for Dana Whitfield, Facilities Manager.\n\n## Scope\n- 2 × curved banquettes, 3.2 m, solid oak frame\n- 6 × lounge chairs, oak, wool bouclé\n- 3 × low tables, smoked glass\n\n## Pricing\n| Item | Qty | EUR |\n|---|---|---|\n| Banquettes | 2 | 17,600 |\n| Lounge chairs | 6 | 13,200 |\n| Low tables | 3 | 4,800 |\n| Delivery and installation | 1 | 2,800 |\n| **Total** | | **38,400** |\n\nValid for 30 days. Lead time 8 weeks from deposit.",
    },
    {
      key: "juniper-proposal-v3",
      name: "Juniper Row – Lobby Proposal v3",
      kind: "document",
      parent: "juniper",
      owner: SAM.email,
      access: "owner",
      modified: t(1, "17:20"),
      modifiedBy: "leo@haldenmoss.example",
      sharedWith: team(),
      content:
        "# Juniper Row Hotel — Lobby seating proposal (v3, walnut)\n\nPrepared for Dana Whitfield, Facilities Manager.\n\n## Changes from v2\n- Walnut slatted finish on banquettes and chair frames\n- 8 lounge chairs instead of 6\n\n## Pricing\n| Item | Qty | EUR |\n|---|---|---|\n| Banquettes, walnut | 2 | 18,900 |\n| Lounge chairs, walnut | 8 | 14,750 |\n| Low tables | 3 | 4,800 |\n| Delivery and installation | 1 | 2,800 |\n| **Total** | | **41,250** |\n\nValid for 30 days. Lead time 9 weeks from deposit (walnut stock).",
    },
    {
      key: "juniper-measurements",
      name: "Juniper Row – Site measurements",
      kind: "spreadsheet",
      parent: "juniper",
      owner: "leo@haldenmoss.example",
      access: "writer",
      modified: t(9),
      sheets: [
        {
          name: "Lobby",
          rows: [
            ["Zone", "Width (mm)", "Depth (mm)", "Notes"],
            ["North wall", "6400", "1800", "Radiator at 2.1 m"],
            ["Window bay", "3200", "1500", "Low sill"],
            ["Reception", "4100", "2600", "Keep 1.5 m clear"],
          ],
        },
      ],
    },
    {
      key: "juniper-msa",
      name: "Juniper Row – Master services agreement (signed).pdf",
      kind: "pdf",
      parent: "juniper",
      owner: SAM.email,
      access: "owner",
      modified: t(52),
      content:
        "Master services agreement between Halden & Moss Ltd and Juniper Row Hotel Ltd. Payment terms: 40% deposit, balance within 30 days of installation. Signed by both parties.",
    },
    {
      key: "kestrel-spec",
      name: "Kestrel – Phone booth acoustic spec",
      kind: "document",
      parent: "kestrel",
      owner: "leo@haldenmoss.example",
      access: "writer",
      modified: t(5),
      content:
        "Booth L2-A and L2-B: replace door seals with 12 mm EPDM, add 9 mm wool felt liner. Target 30 dB reduction.",
    },
    {
      key: "marlowe-moodboard",
      name: "Marlowe Residence – kitchen moodboard.pdf",
      kind: "pdf",
      parent: "marlowe",
      owner: "leo@haldenmoss.example",
      access: "reader",
      modified: t(14),
      content: "Page 1: warm oak, terracotta. Page 2: counter stools, three options.",
    },
    {
      key: "supplier-contacts",
      name: "Supplier contacts",
      kind: "spreadsheet",
      parent: "suppliers",
      owner: SAM.email,
      access: "owner",
      modified: t(21),
      sharedWith: team(),
      sheets: [
        {
          name: "Contacts",
          rows: [
            ["Supplier", "Contact", "Email", "Lead time"],
            ["Ostrava Timber", "Tomás Ruiz", "t.ruiz@ostrava-timber.example", "4 weeks"],
            ["Calder Hardware", "Ines Calder", "ines@calderhardware.example", "1 week"],
            ["Lumen Glassworks", "Dispatch", "dispatch@lumenglass.example", "2 weeks"],
            ["Felt & Fibre", "Order desk", "orders@feltandfibre.example", "3 weeks"],
          ],
        },
      ],
    },
    {
      key: "budget-2026",
      name: "FY2026 Budget",
      kind: "spreadsheet",
      parent: "finance",
      owner: "marta@haldenmoss.example",
      access: "reader",
      modified: t(310),
      sheets: [
        {
          name: "Summary",
          rows: [
            ["Line", "EUR"],
            ["Materials", "212,000"],
            ["Salaries", "388,000"],
            ["Marketing", "64,000"],
            ["Workshop rent", "54,000"],
            ["Total", "718,000"],
          ],
        },
      ],
    },
    {
      key: "budget-2027",
      name: "FY2027 Budget — leadership draft",
      kind: "spreadsheet",
      parent: "finance",
      owner: "marta@haldenmoss.example",
      access: "none",
      modified: t(1, "18:55"),
      sheets: [
        {
          name: "Summary",
          rows: [
            ["Line", "EUR"],
            ["Marketing", "71,500"],
          ],
        },
      ],
    },
    {
      key: "invoices-2026",
      name: "Invoices 2026",
      kind: "spreadsheet",
      parent: "finance",
      owner: "marta@haldenmoss.example",
      access: "writer",
      modified: t(3),
      sheets: [
        {
          name: "Issued",
          rows: [
            ["Invoice", "Client", "EUR", "Status"],
            ["HM-2026-041", "Kestrel Coworking", "9,800", "Paid"],
            ["HM-2026-042", "Marlowe Residence", "6,250", "Due"],
          ],
        },
      ],
    },
    {
      key: "proposal-template",
      name: "Proposal template",
      kind: "document",
      parent: "templates",
      owner: SAM.email,
      access: "owner",
      modified: t(90),
      content:
        "# {Client} — {Project} proposal\n\n## Scope\n\n## Pricing\n| Item | Qty | EUR |\n\nValid for 30 days.",
    },
    {
      key: "brand-guidelines",
      name: "Brand guidelines 2025.pdf",
      kind: "pdf",
      parent: "brand",
      owner: "leo@haldenmoss.example",
      access: "reader",
      modified: t(200),
      content:
        "Typeface: Söhne. Colours: moss green, bone, charcoal. Logo clear space: 1× the ampersand.",
    },
    {
      key: "oct-notes",
      name: "Meeting notes – October 2026",
      kind: "document",
      owner: SAM.email,
      access: "owner",
      modified: t(12),
      content: "Studio meeting: hire a second joiner in Q1; review supplier lead times monthly.",
    },
  ];
}

const SUPPLIERS = [
  "Ostrava Timber",
  "Calder Hardware",
  "Lumen Glassworks",
  "Felt & Fibre",
  "Brightline Lighting",
  "Norrland Upholstery",
];
const PROJECTS = ["Juniper Row Hotel", "Kestrel Coworking", "Marlowe Residence", "Studio stock"];

function notesPages(now: Date): PageSeed[] {
  const t = (days: number) => relativeTime(now, days, "10:00");
  const row = (
    po: string,
    item: string,
    supplier: string,
    status: string,
    eta: string | null,
    project: string,
    edited: number,
    notes = "",
  ): PageSeed => ({
    key: `delivery-${po}`,
    title: `${po} · ${item}`,
    parent: "deliveries",
    properties: {
      Supplier: supplier,
      PO: po,
      Status: status,
      ETA: eta,
      Project: project,
      Owner: ["Sam Okafor"],
      Notes: notes,
    },
    edited: t(edited),
    editedBy: "Sam Okafor",
  });
  const generated = Array.from({ length: 18 }, (_, i) => {
    const po = `PO-${4400 + i}`;
    return row(
      po,
      [
        "Walnut veneer",
        "Steel legs",
        "Foam inserts",
        "Linen fabric",
        "Brass fittings",
        "Pendant shades",
      ][i % 6]!,
      SUPPLIERS[(i * 5) % SUPPLIERS.length]!,
      i === 7 ? "Cancelled" : "Delivered",
      relativeDate(now, -60 + i * 2),
      PROJECTS[i % PROJECTS.length]!,
      55 - i * 2,
    );
  });
  return [
    {
      key: "operations",
      title: "Operations",
      icon: "🧰",
      edited: t(8),
      blocks: [
        {
          type: "paragraph",
          text: "Everything the studio needs to keep orders, deliveries and clients moving.",
        },
        { type: "heading_2", text: "Trackers" },
        { type: "bulleted_list_item", text: "Supplier deliveries — one row per purchase order" },
        { type: "bulleted_list_item", text: "Client projects" },
      ],
    },
    ...generated,
    row(
      "PO-4419",
      "Black steel brackets",
      "Calder Hardware",
      "Delivered",
      relativeDate(now, -20),
      "Kestrel Coworking",
      20,
    ),
    row(
      "PO-4458",
      "Ash boards 25mm",
      "Ostrava Timber",
      "Delivered",
      relativeDate(now, -9),
      "Studio stock",
      9,
    ),
    row(
      "PO-4465",
      "Drawer pulls & hinges",
      "Calder Hardware",
      "In transit",
      relativeDate(now, 0),
      "Juniper Row Hotel",
      6,
    ),
    row(
      "PO-4471",
      "Oak boards 32mm",
      "Ostrava Timber",
      "In transit",
      relativeDate(now, 7),
      "Juniper Row Hotel",
      12,
    ),
    row(
      "PO-4476",
      "Wool felt panels",
      "Felt & Fibre",
      "Ordered",
      relativeDate(now, 14),
      "Kestrel Coworking",
      7,
    ),
    row(
      "PO-4480",
      "Smoked glass tops",
      "Lumen Glassworks",
      "Ordered",
      null,
      "Juniper Row Hotel",
      10,
    ),
    row(
      "PO-4483",
      "Oak boards 45mm",
      "Ostrava Timber",
      "Ordered",
      relativeDate(now, 24),
      "Marlowe Residence",
      3,
    ),
    {
      key: "project-juniper",
      title: "Juniper Row Hotel — lobby",
      parent: "projects",
      properties: {
        Stage: "Proposal",
        Lead: ["Leo Brandt"],
        Value: 41250,
        Due: relativeDate(now, 70),
      },
      edited: t(1),
    },
    {
      key: "project-kestrel",
      title: "Kestrel Coworking — booths",
      parent: "projects",
      properties: {
        Stage: "In production",
        Lead: ["Leo Brandt"],
        Value: 9800,
        Due: relativeDate(now, 50),
      },
      edited: t(5),
    },
    {
      key: "project-marlowe",
      title: "Marlowe Residence — kitchen",
      parent: "projects",
      properties: {
        Stage: "Design",
        Lead: ["Aisha Bello"],
        Value: 6250,
        Due: relativeDate(now, 90),
      },
      edited: t(14),
    },
    {
      key: "ops-sync",
      title: "Weekly ops sync",
      parent: "operations",
      edited: t(3),
      editedBy: "Aisha Bello",
      blocks: [
        { type: "heading_2", text: "Last week" },
        { type: "bulleted_list_item", text: "Juniper v3 proposal in progress (Leo)" },
        { type: "bulleted_list_item", text: "Chase Felt & Fibre on colour for PO-4476" },
        { type: "to_do", text: "Update delivery tracker every Friday", checked: false },
        { type: "divider" },
        { type: "paragraph", text: "Next sync: Monday 09:30." },
      ],
    },
    {
      key: "pricing-policy",
      title: "Pricing policy",
      parent: "operations",
      access: "view",
      edited: t(120),
      editedBy: "Marta Kovács",
      blocks: [
        {
          type: "paragraph",
          text: "Proposals are valid 30 days. Discounts above 5% need Marta's sign-off.",
        },
      ],
    },
    {
      key: "leadership",
      title: "Leadership — FY2027 planning",
      access: "unshared",
      edited: t(1),
      blocks: [{ type: "paragraph", text: "Marketing budget FY2027: EUR 71,500 (draft)." }],
    },
  ];
}

export type StudioOptions = { now: Date; faults?: AppFault[] };

export const studioMail = ({ now, faults }: StudioOptions) =>
  new MailEmulator(
    {
      account: SAM,
      labels: ["Clients", "Suppliers", "Finance", "Receipts"],
      threads: threads(now),
    },
    { now, faults },
  );

export const studioFiles = ({ now }: { now: Date }) =>
  new FilesEmulator({ account: SAM, baseUrl: FILES_URL, files: files(now) }, { now });

export const studioNotes = ({ now }: { now: Date }) =>
  new NotesEmulator(
    {
      workspace: "Halden & Moss",
      baseUrl: "https://notes.example.com/haldenmoss",
      member: "Sam Okafor",
      databases: [
        {
          key: "deliveries",
          title: "Supplier deliveries",
          parent: "operations",
          description:
            "One row per purchase order. Update Status and ETA when suppliers confirm changes.",
          edited: relativeTime(now, 3),
          properties: {
            Order: { type: "title" },
            Supplier: { type: "select", options: SUPPLIERS },
            PO: { type: "rich_text" },
            Status: {
              type: "status",
              options: ["Ordered", "In transit", "Delayed", "Delivered", "Cancelled"],
            },
            ETA: { type: "date" },
            Project: { type: "select", options: PROJECTS },
            Owner: { type: "people" },
            Notes: { type: "rich_text" },
          },
        },
        {
          key: "projects",
          title: "Client projects",
          parent: "operations",
          edited: relativeTime(now, 1),
          properties: {
            Project: { type: "title" },
            Stage: {
              type: "status",
              options: ["Lead", "Design", "Proposal", "In production", "Installed"],
            },
            Lead: { type: "people" },
            Value: { type: "number" },
            Due: { type: "date" },
          },
        },
      ],
      pages: notesPages(now),
    },
    { now },
  );
