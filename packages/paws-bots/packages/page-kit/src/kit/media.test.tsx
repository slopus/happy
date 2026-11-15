// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_CSS, DayView, MonthView, parseDay, WeekView } from "./calendar.js";
import {
  Audio,
  Avatar,
  AvatarStack,
  aspectRatio,
  CardCarousel,
  CardGrid,
  Gallery,
  Image,
  initials,
  PhotoStrip,
  ProductCard,
  ProductRows,
  RatingSummary,
  Video,
  WatchCard,
} from "./media.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const WEBM = "data:video/webm;base64,GkXfow==";
const WAV = "data:audio/wav;base64,UklGRg==";

let host: HTMLDivElement;
let posted: unknown[];
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  window.matchMedia ??= (() => ({ matches: false })) as never;
  Element.prototype.scrollTo ??= () => {};
});
afterEach(() => {
  host.remove();
  document.documentElement.removeAttribute("data-reply");
  vi.restoreAllMocks();
});

function render(element: ReactElement) {
  const root = createRoot(host.appendChild(document.createElement("div")));
  act(() => root.render(element));
}
const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const click = (element: Element | null) => act(() => (element as HTMLElement).click());

describe("media", () => {
  it("shows only embedded pictures and sound, never a network address", () => {
    render(
      <>
        <Image src="https://example.com/a.png" alt="remote" />
        <Image src={"javascript:alert(1)"} alt="script" />
        <Video src="https://example.com/a.webm" alt="remote video" />
        <Audio src="http://example.com/a.mp3" alt="remote sound" />
        <Audio src={WEBM} alt="video posing as sound" />
      </>,
    );
    expect(host.textContent).toBe("");
    expect(host.querySelector("img, video, audio, figure")).toBeNull();
    render(
      <>
        <Image src={PNG} alt="Harbour" caption="At dusk" ratio="16/9" />
        <Video src={WEBM} alt="Clip" />
        <Audio src={WAV} alt="Tone" caption="One second" />
        <Video src="blob:null/1234" alt="Made here" />
      </>,
    );
    expect(q<HTMLImageElement>("img")!.alt).toBe("Harbour");
    expect(q("figcaption")!.textContent).toBe("At dusk");
    expect(all("video").map((video) => video.getAttribute("aria-label"))).toEqual([
      "Clip",
      "Made here",
    ]);
    expect(q("audio")!.getAttribute("aria-label")).toBe("Tone");
    expect([aspectRatio("4:3"), aspectRatio(1.5), aspectRatio("wide"), aspectRatio(-1)]).toEqual([
      4 / 3,
      1.5,
      undefined,
      undefined,
    ]);
  });

  it("shows the poster in place of a video that cannot play", () => {
    render(<Video src="https://example.com/x.webm" poster={PNG} alt="Clip" />);
    expect(q('[role="img"]')!.getAttribute("aria-label")).toBe("Clip");
    expect(q("video")).toBeNull();
  });

  it("tries a new video source again after the previous one failed", () => {
    const root = createRoot(host.appendChild(document.createElement("div")));
    act(() => root.render(<Video src="data:video/webm;base64,QQ==" />));
    act(() => q("video")!.dispatchEvent(new Event("error")));
    expect(q("video")).toBeNull();
    act(() => root.render(<Video src="data:video/webm;base64,Qg==" />));
    expect(q("video")).not.toBeNull();
    act(() => root.unmount());
  });

  it("enlarges a picture on click and closes it with Escape, returning focus", () => {
    render(<Image src={PNG} alt="Harbour" />);
    const opener = q<HTMLButtonElement>('button[aria-label="Enlarge Harbour"]')!;
    opener.focus();
    click(opener);
    const dialog = q('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(q('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps a gallery to eight photos and moves its marker with the dots and arrow keys", () => {
    const photos = Array.from({ length: 10 }, (_, index) => ({ src: PNG, alt: `P${index}` }));
    render(<Gallery photos={[{ src: "https://example.com/x.png", alt: "remote" }, ...photos]} />);
    expect(all(".rk-gallery-slide")).toHaveLength(8);
    const current = () => all("button[aria-current]").map((dot) => dot.getAttribute("aria-label"));
    expect(current()).toEqual(["Show photo 1"]);
    click(q('button[aria-label="Show photo 3"]'));
    expect(current()).toEqual(["Show photo 3"]);
    act(() => {
      q(".rk-gallery-track")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(current()).toEqual(["Show photo 2"]);
    render(<Gallery photos={[]} />);
  });

  it("keeps a photo marked when the gallery loses the one that was shown", () => {
    const photos = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ src: PNG, alt: `P${index}` }));
    const root = createRoot(host.appendChild(document.createElement("div")));
    act(() => root.render(<Gallery photos={photos(5)} />));
    click(q('button[aria-label="Show photo 5"]'));
    act(() => root.render(<Gallery photos={photos(2)} />));
    const current = () => all("button[aria-current]").map((dot) => dot.getAttribute("aria-label"));
    expect(current()).toEqual(["Show photo 2"]);
    act(() => {
      q(".rk-gallery-track")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(current()).toEqual(["Show photo 1"]);
    act(() => root.unmount());
  });

  describe.each([
    { dir: "ltr", sign: 1, forward: "ArrowRight", back: "ArrowLeft" },
    { dir: "rtl", sign: -1, forward: "ArrowLeft", back: "ArrowRight" },
  ])("in a $dir page", ({ dir, sign, forward, back }) => {
    const WIDTH = 300;
    const mountGallery = () => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(WIDTH);
      const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
      const wrapper = host.appendChild(document.createElement("div"));
      wrapper.dir = dir;
      const root = createRoot(wrapper);
      act(() => root.render(<Gallery photos={[{ src: PNG }, { src: PNG }, { src: PNG }]} />));
      const track = wrapper.querySelector<HTMLElement>(".rk-gallery-track")!;
      const current = () =>
        [...wrapper.querySelectorAll("button[aria-current]")].map((dot) =>
          dot.getAttribute("aria-label"),
        );
      const press = (key: string) =>
        act(() => {
          track.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });
      const scrollTrack = (left: number) =>
        act(() => {
          Object.defineProperty(track, "scrollLeft", { value: left, configurable: true });
          track.dispatchEvent(new Event("scroll"));
        });
      return { wrapper, scrollTo, current, press, scrollTrack };
    };

    it("scrolls to the chosen photo's side and marks its dot", () => {
      const { wrapper, scrollTo, current } = mountGallery();
      click(wrapper.querySelector('button[aria-label="Show photo 2"]'));
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: sign * WIDTH }));
      expect(current()).toEqual(["Show photo 2"]);
    });

    it("marks the photo the track has scrolled to, never none", () => {
      const { current, scrollTrack } = mountGallery();
      scrollTrack(sign * WIDTH);
      expect(current()).toEqual(["Show photo 2"]);
      scrollTrack(sign * 2 * WIDTH);
      expect(current()).toEqual(["Show photo 3"]);
      scrollTrack(0);
      expect(current()).toEqual(["Show photo 1"]);
      scrollTrack(-sign * WIDTH);
      expect(current()).toEqual(["Show photo 1"]);
      scrollTrack(sign * 5 * WIDTH);
      expect(current()).toEqual(["Show photo 3"]);
    });

    it("steps with the arrow that points the way the photos lie, stopping at both ends", () => {
      const { scrollTo, current, press } = mountGallery();
      press(back);
      expect(current()).toEqual(["Show photo 1"]);
      press(forward);
      expect(current()).toEqual(["Show photo 2"]);
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: sign * WIDTH }));
      press(forward);
      press(forward);
      expect(current()).toEqual(["Show photo 3"]);
      press(back);
      expect(current()).toEqual(["Show photo 2"]);
    });
  });
});

describe("cards and people", () => {
  const item = {
    title: "Linen shirt",
    href: "https://example.com/shirt",
    image: PNG,
    price: "$48",
    note: "Free returns",
    badge: "New",
    store: "Northwind",
    rating: 4.6,
    reviews: 1214,
  };

  it("lays out a product with its price, store rating and a link the host opens", () => {
    render(<ProductCard {...item} />);
    expect(q(".rk-card-title")!.textContent).toBe("Linen shirt");
    expect(q(".rk-badge")!.textContent).toBe("New");
    expect(q(".rk-card-price")!.textContent).toBe("$48 · Free returns");
    expect(q(".rk-store")!.getAttribute("aria-label")).toBe(
      "Northwind, rated 4.6 out of 5 from 1,214 ratings",
    );
    click(q("a"));
    expect(posted).toEqual([{ type: "rakazo-page:open-link", url: "https://example.com/shirt" }]);
    // The pill says only "View" so it never wraps; the link's name still says what it opens.
    expect(q("a")!.textContent).toBe("View");
    expect(q("a")!.getAttribute("aria-label")).toBe("View Linen shirt");
  });

  it("makes a compact card one link and drops products and tiles with nothing to show", () => {
    render(
      <>
        <ProductCard {...item} compact />
        <ProductCard title="" />
        <ProductRows items={[item, { title: "Scarf", price: "$35" }, { price: "$1" }]} />
        <PhotoStrip items={[{ title: "Tote", image: PNG, href: "https://example.com/t" }, {}]} />
      </>,
    );
    expect(q(".rk-card-link")!.getAttribute("title")).toBe("Linen shirt");
    expect(all(".rk-product-row")).toHaveLength(2);
    expect(all(".rk-product-row")[1]!.tagName).toBe("DIV");
    expect(all(".rk-strip > li")).toHaveLength(1);
    expect(q(".rk-strip a")!.getAttribute("aria-label")).toBe("View Tote");
  });

  it("states a rating in words and fills the stars to the score", () => {
    render(
      <>
        <RatingSummary rating={4.3} reviews={1280} />
        <RatingSummary rating={9} />
        <RatingSummary rating={Number.NaN} />
      </>,
    );
    const ratings = all(".rk-rating");
    expect(ratings.map((rating) => rating.getAttribute("aria-label"))).toEqual([
      "Rated 4.3 out of 5 from 1,280 ratings",
      "Rated 5 out of 5",
    ]);
    const first = ratings[0]!;
    expect(first.querySelectorAll(".rk-star-full")).toHaveLength(5);
    expect(Number(first.querySelector("clipPath rect")!.getAttribute("width"))).toBeCloseTo(3.6);
  });

  it("sends a watch card's request to the composer only where there is one", () => {
    document.documentElement.setAttribute("data-reply", "");
    render(<WatchCard title="Price drop" detail="Under $40" reply="Watch the shirt under $40" />);
    expect(q(".rk-watch-detail")!.textContent).toBe("Under $40");
    click(q("button"));
    expect(posted).toEqual([{ type: "rakazo-page:reply", text: "Watch the shirt under $40" }]);
  });

  it("puts cards in a list or a carousel and skips empty children", () => {
    render(
      <>
        <CardGrid label="Products">{[<ProductCard key="a" {...item} />, null, false]}</CardGrid>
        <CardCarousel label="More">
          <ProductCard {...item} />
          <ProductCard {...item} />
        </CardCarousel>
        <CardGrid>{null}</CardGrid>
      </>,
    );
    expect(all(".rk-card-grid > li")).toHaveLength(1);
    expect(
      all(".rk-card-carousel > figure").map((slide) => slide.getAttribute("aria-label")),
    ).toEqual(["1 of 2", "2 of 2"]);
  });

  it("draws initials, keeps a person's colour, and folds a crowd into a count", () => {
    expect([initials("Ana Lima"), initials("bo"), initials("Mary Ann de Souza")]).toEqual([
      "AL",
      "B",
      "MS",
    ]);
    render(
      <>
        <Avatar name="Ana Lima" />
        <Avatar name="Ana Lima" size={48} />
        <Avatar name="" />
        <AvatarStack
          people={["Ana Lima", { name: "Ben Ode" }, "Cy Park", "Dee Ray", "Eli Su", "Fay Tao"]}
          max={4}
          label="Team"
        />
      </>,
    );
    const avatars = all(".rk-avatar");
    expect(avatars[0]!.style.background).toBe(avatars[1]!.style.background);
    expect(avatars[1]!.style.width).toBe("48px");
    const more = q('[aria-label="2 more"]')!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("title")).toBe("Eli Su, Fay Tao");
    expect(q(".rk-avatar-names")!.textContent).toBe(
      "Ana Lima, Ben Ode, Cy Park, Dee Ray, and 2 more",
    );
  });
});

describe("calendar", () => {
  it("colours today and the selected event from the theme, never a fixed hex", () => {
    expect(CALENDAR_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("reads only real calendar days", () => {
    expect(parseDay("2026-02-30")).toBeUndefined();
    // Neither a month past December nor a two-digit year rolls into some other real date.
    expect(parseDay("2026-13-01")).toBeUndefined();
    expect(parseDay("2026-00-10")).toBeUndefined();
    expect(parseDay("0050-03-01")).toBeUndefined();
    expect(parseDay("2026-11-12")?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
  });

  it("lays a month out from Monday, marks today and folds a busy day into +N more", () => {
    render(
      <MonthView
        month="2026-11"
        today="2026-11-12"
        events={[
          { date: "2026-11-12", title: "Launch", selected: true },
          { date: "2026-11-12", title: "Press" },
          { date: "2026-11-12", title: "Dinner" },
          { date: "2026-11-12", title: "Review" },
          { date: "2026-11-20", title: "Free", free: true },
          { date: "nope", title: "Lost" },
        ]}
      />,
    );
    expect(q("table")!.getAttribute("aria-label")).toBe("November 2026");
    // 1 November 2026 is a Sunday, the seventh column.
    expect(all("tbody tr")[0]!.querySelectorAll(".rk-cal-date")[0]!.textContent).toBe("1");
    expect(all("tbody tr")[0]!.querySelectorAll("td")[6]!.textContent).toBe("1");
    expect(all("tbody tr")).toHaveLength(6);
    expect(q('[aria-current="date"]')!.textContent).toBe("12");
    expect(q(".rk-cal-more")!.textContent).toBe("+2 more");
    const more = q<HTMLDetailsElement>("details")!;
    expect(more.textContent).toContain("DinnerReview");
    // A native disclosure, so keyboard and touch open it without page script.
    expect(more.querySelector("summary")).not.toBeNull();
    more.setAttribute("open", "");
    expect(more.open).toBe(true);
    expect(all(".rk-cal-chip").map((chip) => chip.dataset.kind ?? "")).toEqual([
      "selected",
      "",
      "",
      "",
      "free",
    ]);
    expect(host.textContent).not.toContain("Lost");
    render(<MonthView month="soon" />);
  });

  it("sizes a week from visible events only, including the first and last day", () => {
    render(
      <WeekView
        week="2026-11-09"
        events={[
          { date: "2026-11-08", start: 0, end: 1, title: "Previous week" },
          { date: " 2026-11-09 ", start: 9, end: 10, title: "First day" },
          { date: "2026-11-15", start: 10, end: 11, title: "Last day" },
          { date: "2026-11-16", start: 22, end: 23, title: "Next week" },
        ]}
      />,
    );
    expect((host.querySelector(".rk-cal-body") as HTMLElement).style.height).toBe("88px");
    expect(host.textContent).toContain("First day");
    expect(host.textContent).toContain("Last day");
    expect(host.textContent).not.toContain("Previous week");
    expect(host.textContent).not.toContain("Next week");
  });

  it("uses the empty-week range when every event is outside the displayed days", () => {
    render(
      <WeekView
        week="2026-12-28"
        events={[
          { date: "2026-12-27", start: 0, end: 1, title: "Before" },
          { date: "2027-01-04", start: 22, end: 23, title: "After" },
        ]}
      />,
    );
    expect((host.querySelector(".rk-cal-body") as HTMLElement).style.height).toBe("440px");
  });

  it("places week events by hour and draws the now line only on today", () => {
    render(
      <WeekView
        week="2026-11-09"
        start={8}
        end={18}
        today="2026-11-12"
        now={13.5}
        events={[
          { date: "2026-11-09", start: 9, end: 10.5, title: "Standup" },
          { date: "2026-11-12", start: 20, end: 21, title: "Too late" },
        ]}
      />,
    );
    const event = q<HTMLElement>(".rk-cal-event")!;
    expect(event.style.top).toBe("45px");
    expect(event.style.height).toBe("64px");
    expect(host.textContent).not.toContain("Too late");
    const lines = all(".rk-cal-now");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest(".rk-cal-column")!.hasAttribute("data-today")).toBe(true);
    expect(lines[0]!.style.top).toBe(`${5.5 * 44}px`);
  });

  it("strikes a day's events that ended before the mark and shows their times", () => {
    render(
      <DayView
        start={9}
        end={17}
        mark={{ at: 12.25 }}
        events={[
          { start: 9, end: 10, title: "Inbox" },
          { start: 14, end: 15.5, title: "Call", selected: true },
        ]}
      />,
    );
    const [inbox, call] = all(".rk-cal-event");
    expect(inbox!.hasAttribute("data-done")).toBe(true);
    expect(call!.hasAttribute("data-done")).toBe(false);
    expect(call!.querySelector(".rk-cal-event-time")!.textContent).toBe("2 PM – 3:30 PM");
  });

  it("gives an event without an end its hour: fitted in the day and not done before then", () => {
    render(
      <DayView
        mark={{ at: 10.5 }}
        events={[
          { start: 9, title: "Standup" },
          { start: 10, title: "Review" },
        ]}
      />,
    );
    const [standup, review] = all(".rk-cal-event");
    expect(review).toBeDefined();
    expect(standup!.hasAttribute("data-done")).toBe(true);
    expect(review!.hasAttribute("data-done")).toBe(false);
  });

  it("leaves out events outside the day's hours or ending before they start, and clips the rest", () => {
    render(
      <DayView
        start={8}
        end={18}
        events={[
          { title: "before", start: 6, end: 7 },
          { title: "after", start: 19, end: 20 },
          { title: "reverse", start: 10, end: 9 },
          { title: "clip", start: 7, end: 9 },
        ]}
      />,
    );
    expect(all(".rk-cal-event").map((n) => n.textContent)).toEqual(["clip8 AM – 9 AM"]);
  });

  it("gives identical and partly overlapping events their own lanes in day and week views", () => {
    for (const View of [DayView, WeekView]) {
      const root = createRoot(host.appendChild(document.createElement("div")));
      act(() =>
        root.render(
          <View
            week="2026-10-26"
            start={8}
            end={18}
            events={[
              { date: "2026-10-26", title: "A", start: 9, end: 10 },
              { date: "2026-10-26", title: "B", start: 9, end: 10 },
              { date: "2026-10-26", title: "C", start: 9.5, end: 11 },
            ]}
          />,
        ),
      );
      const nodes = all(".rk-cal-event");
      expect(nodes).toHaveLength(3);
      expect(new Set(nodes.map((n) => n.style.left)).size).toBe(3);
      act(() => root.unmount());
    }
  });
});
