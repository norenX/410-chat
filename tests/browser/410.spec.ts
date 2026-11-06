import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { AdminStatsSnapshot } from "../../shared/admin-stats.js";

type ClipboardWindow = Window & { __copiedInvite?: string };

async function installWorkingClipboard(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as ClipboardWindow).__copiedInvite = value;
        }
      }
    });
  });
}

async function installDeniedClipboard(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } }
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false
    });
  });
}

async function navigateDocument(page: Page, url: string) {
  const requested = new URL(url);
  const expectedDocumentUrl = `${requested.origin}${requested.pathname}${requested.search}`;
  const responsePromise = page.waitForResponse((response) =>
    response.request().resourceType() === "document" && response.url() === expectedDocumentUrl
  );
  await page.evaluate((target) => { window.location.assign(target); }, url);
  const response = await responsePromise;
  await expect.poll(() => {
    const current = new URL(page.url());
    return `${current.origin}${current.pathname}${current.search}`;
  }).toBe(expectedDocumentUrl);
  return response;
}

async function createActivePair(browser: Browser, baseURL: string) {
  const creatorContext = await browser.newContext();
  await installWorkingClipboard(creatorContext);
  const joinerContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();

  await navigateDocument(creator, baseURL);
  await creator.getByRole("button", { name: "Start" }).click();
  await expect(creator.getByText("Waiting for one person.")).toBeVisible();
  const invite = await creator.getByLabel("One-time conversation link").inputValue();

  const inviteResponse = await navigateDocument(joiner, invite);
  expect(inviteResponse?.status()).toBe(200);
  await expect(creator.locator("#message")).toBeEnabled();
  await expect(joiner.locator("#message")).toBeEnabled();
  return { creatorContext, joinerContext, creator, joiner, invite };
}

async function waitForGone(page: Page): Promise<void> {
  await expect(page).toHaveTitle("410 Gone");
  await expect(page.getByRole("heading", { name: "410 Gone", exact: true })).toBeVisible();
  await expect(page.getByText("This conversation no longer exists.", { exact: true })).toBeVisible();
  expect(await page.locator("body").evaluate((body) =>
    Array.from(body.children).map((element) => ({ tag: element.tagName, text: element.textContent }))
  )).toEqual([
    { tag: "H1", text: "410 Gone" },
    { tag: "P", text: "This conversation no longer exists." }
  ]);
  await expect(page.locator("button")).toHaveCount(0);
  await expect(page.locator("a")).toHaveCount(0);
  await expect(page.locator("script")).toHaveCount(0);
  await expect(page.locator("style, link[rel='stylesheet'], [style]")).toHaveCount(0);
  await expect(page.locator("#root, main, div")).toHaveCount(0);
}

async function openGroupInvite(page: Page, invite: string): Promise<void> {
  const expected = new URL(invite);
  const inviteToken = expected.pathname.split("/").at(-1)!;
  const linkSecret = new URLSearchParams(expected.hash.slice(1)).get("secret");
  if (!linkSecret) throw new Error("Group invite is missing its fragment secret");
  const tabToken = await page.evaluate(() => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  });
  await page.addInitScript(({ pathname, token, secret, tab }) => {
    if (location.pathname !== pathname) return;
    sessionStorage.setItem(`410.group.tab.v1.${token}`, tab);
    sessionStorage.setItem("410.group.session.v1", JSON.stringify({
      version: 1,
      inviteToken: token,
      linkSecret: secret,
      expiresAt: Number.MAX_SAFE_INTEGER
    }));
  }, { pathname: expected.pathname, token: inviteToken, secret: linkSecret, tab: tabToken });
  await navigateDocument(page, `${expected.origin}${expected.pathname}`);
}

async function sendMessages(page: Page, count: number, prefix: string): Promise<void> {
  await page.locator("#message").evaluate(async (element, options) => {
    const textarea = element as HTMLTextAreaElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("textarea value setter unavailable");
    for (let index = 0; index < options.count; index += 1) {
      valueSetter.call(textarea, `${options.prefix} ${index}`);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, { count, prefix });
}

async function conversationMetrics(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".session-header")!;
    const messages = document.querySelector<HTMLElement>(".message-list")!;
    const composer = document.querySelector<HTMLElement>(".composer")!;
    const headerRect = header.getBoundingClientRect();
    const messagesRect = messages.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      windowScrollY: scrollY,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      header: { top: headerRect.top, bottom: headerRect.bottom },
      messages: {
        top: messagesRect.top,
        bottom: messagesRect.bottom,
        clientHeight: messages.clientHeight,
        scrollHeight: messages.scrollHeight,
        clientWidth: messages.clientWidth,
        scrollWidth: messages.scrollWidth,
        overflowY: getComputedStyle(messages).overflowY
      },
      composer: { top: composerRect.top, bottom: composerRect.bottom }
    };
  });
}

function expectViewportLocked(metrics: Awaited<ReturnType<typeof conversationMetrics>>): void {
  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.documentHeight).toBeLessThanOrEqual(metrics.viewport.height + 1);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.viewport.height + 1);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.header.top).toBeGreaterThanOrEqual(0);
  expect(metrics.header.bottom).toBeLessThan(metrics.messages.bottom);
  expect(metrics.messages.top).toBeGreaterThanOrEqual(metrics.header.bottom - 1);
  expect(metrics.messages.bottom).toBeLessThanOrEqual(metrics.composer.top + 1);
  expect(metrics.composer.bottom).toBeLessThanOrEqual(metrics.viewport.height + 1);
  expect(metrics.messages.overflowY).toBe("auto");
  expect(metrics.messages.scrollHeight).toBeGreaterThan(metrics.messages.clientHeight);
  expect(metrics.messages.scrollWidth).toBeLessThanOrEqual(metrics.messages.clientWidth + 1);
}

async function informationPageLayout(page: Page) {
  return page.evaluate(() => {
    const rounded = (value: number) => Math.round(value * 1000) / 1000;
    const pageElement = document.querySelector<HTMLElement>(".security-page")!;
    const documentElement = document.querySelector<HTMLElement>(".security-document")!;
    const header = document.querySelector<HTMLElement>(".security-header")!;
    const brand = document.querySelector<HTMLElement>(".security-brand")!;
    const source = document.querySelector<HTMLElement>(".security-source")!;
    const heading = document.querySelector<HTMLElement>(".security-document h1")!;
    const introduction = document.querySelector<HTMLElement>(".security-introduction")!;
    const firstSection = document.querySelector<HTMLElement>(".security-document section")!;
    const firstSectionHeading = firstSection.querySelector<HTMLElement>("h2")!;
    const pageStyle = getComputedStyle(pageElement);
    const documentRect = documentElement.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const introductionRect = introduction.getBoundingClientRect();
    const firstSectionRect = firstSection.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      pagePaddingTop: rounded(Number.parseFloat(pageStyle.paddingTop)),
      pagePaddingInline: rounded(Number.parseFloat(pageStyle.paddingLeft)),
      documentLeft: rounded(documentRect.left),
      documentRight: rounded(documentRect.right),
      documentWidth: rounded(documentRect.width),
      headerTop: rounded(headerRect.top),
      brandLeft: rounded(brand.getBoundingClientRect().left),
      sourceRight: rounded(source.getBoundingClientRect().right),
      headerHeadingGap: rounded(headingRect.top - headerRect.bottom),
      headingSize: rounded(Number.parseFloat(getComputedStyle(heading).fontSize)),
      introductionGap: rounded(introductionRect.top - headingRect.bottom),
      introductionSize: rounded(Number.parseFloat(getComputedStyle(introduction).fontSize)),
      sectionGap: rounded(firstSectionRect.top - introductionRect.bottom),
      sectionHeadingSize: rounded(Number.parseFloat(getComputedStyle(firstSectionHeading).fontSize))
    };
  });
}

test("admin stats polls aggregate direct and group counters without losing the last snapshot", async ({ page, baseURL }) => {
  const before = await (await page.request.get(`${baseURL}/__stats`)).json() as {
    today: Record<string, number>;
    totals: Record<string, number>;
    groups: { today: Record<string, number>; totals: Record<string, number> };
  };
  let requestCount = 0;
  let failRequests = false;
  let payload: AdminStatsSnapshot = {
    direct: {
      now: { waiting: 2, active: 1 },
      today: {
        homepage_views: 12,
        rooms_created: 3,
        conversations_started: 2,
        messages_relayed: 7,
        responses_410: 4
      },
      totals: {
        homepage_views: 120,
        rooms_created: 30,
        conversations_started: 20,
        messages_relayed: 70,
        responses_410: 40
      }
    },
    group: {
      now: { rooms: 1, people: 4 },
      today: {
        group_rooms_created: 2,
        group_participants_joined: 6,
        group_messages_relayed: 8,
        group_responses_410: 3
      },
      totals: {
        group_rooms_created: 9,
        group_participants_joined: 22,
        group_messages_relayed: 44,
        group_responses_410: 11
      }
    }
  };

  await page.route("**/admin/api/stats", async (route) => {
    requestCount += 1;
    if (failRequests) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      return;
    }
    await route.fulfill({ json: payload });
  });

  expect((await navigateDocument(page, `${baseURL}/admin/stats`)).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "410.chat stats" })).toBeVisible();
  const direct = page.getByRole("region", { name: "DIRECT" });
  const group = page.getByRole("region", { name: "GROUP" });
  await expect(direct).toBeVisible();
  await expect(group).toBeVisible();
  await expect(page.getByRole("status")).toContainText("LIVE");
  await expect(page.getByText(/Updated \d{2}:\d{2}:\d{2}/)).toBeVisible();
  await expect(direct.locator(".admin-stats-period").nth(0).locator("dd")).toHaveText(["2", "1"]);
  await expect(direct.locator(".admin-stats-period").nth(1).locator("dd")).toHaveText(["12", "3", "2", "7", "4"]);
  await expect(direct.locator(".admin-stats-period").nth(2).locator("dd")).toHaveText(["120", "30", "20", "70", "40"]);
  await expect(group.locator(".admin-stats-period").nth(0).locator("dd")).toHaveText(["1", "4"]);
  await expect(group.locator(".admin-stats-period").nth(1).locator("dd")).toHaveText(["2", "6", "8", "3"]);
  await expect(group.locator(".admin-stats-period").nth(2).locator("dd")).toHaveText(["9", "22", "44", "11"]);

  payload = {
    ...payload,
    direct: {
      ...payload.direct,
      today: { ...payload.direct.today, homepage_views: 13 }
    },
    group: {
      ...payload.group,
      today: { ...payload.group.today, group_participants_joined: 7 }
    }
  };
  await expect.poll(() => requestCount, { timeout: 7000 }).toBeGreaterThanOrEqual(2);
  await expect(direct.locator(".admin-stats-period").nth(1).locator("dd").first()).toHaveText("13");
  await expect(group.locator(".admin-stats-period").nth(1).locator("dd").nth(1)).toHaveText("7");

  failRequests = true;
  await expect.poll(() => requestCount, { timeout: 7000 }).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("status")).toContainText("UPDATE FAILED");
  await expect(direct.locator(".admin-stats-period").nth(1).locator("dd").first()).toHaveText("13");
  await expect(group.locator(".admin-stats-period").nth(1).locator("dd").nth(1)).toHaveText("7");

  failRequests = false;
  payload = {
    ...payload,
    direct: {
      ...payload.direct,
      today: { ...payload.direct.today, homepage_views: 14 }
    }
  };
  await expect.poll(() => requestCount, { timeout: 7000 }).toBeGreaterThanOrEqual(4);
  await expect(page.getByRole("status")).toContainText("LIVE");
  await expect(direct.locator(".admin-stats-period").nth(1).locator("dd").first()).toHaveText("14");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    periodColumns: getComputedStyle(document.querySelector<HTMLElement>(".admin-stats-periods")!).gridTemplateColumns,
    contentLeft: document.querySelector<HTMLElement>(".admin-stats-shell")!.getBoundingClientRect().left
  }));
  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(mobile.periodColumns.split(" ")).toHaveLength(1);
  expect(mobile.contentLeft).toBeGreaterThanOrEqual(20);
  await expect(page.locator("a, button")).toHaveCount(0);

  const after = await (await page.request.get(`${baseURL}/__stats`)).json() as typeof before;
  expect(after.today).toEqual(before.today);
  expect(after.totals).toEqual(before.totals);
  expect(after.groups.today).toEqual(before.groups.today);
  expect(after.groups.totals).toEqual(before.groups.totals);
});

test("How it works is a direct, concise, mobile-safe product guide with working navigation", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigateDocument(page, baseURL!);
  const howLink = page.getByRole("link", { name: "How it works →", exact: true });
  await expect(howLink).toHaveAttribute("href", "/how-it-works");

  const howResponsePromise = page.waitForResponse((response) =>
    response.request().resourceType() === "document" && new URL(response.url()).pathname === "/how-it-works"
  );
  await howLink.click();
  expect((await howResponsePromise).status()).toBe(200);
  await expect(page).toHaveURL(`${baseURL}/how-it-works`);
  await expect(page).toHaveTitle("How it works — 410");
  await expect(page.getByRole("heading", { level: 1, name: "How it works", exact: true })).toBeVisible();
  expect(await page.locator(".how-document h2").allTextContents()).toEqual([
    "1-TO-1",
    "ROOM",
    "NO HISTORY",
    "GONE"
  ]);
  await expect(page.getByText("410 is temporary by design.", { exact: true })).toBeVisible();
  await expect(page.getByText("Once the second person joins, the invite cannot be used again.", { exact: true })).toBeVisible();
  await expect(page.getByText("People can leave and come back while the room still exists.", { exact: true })).toBeVisible();
  await expect(page.getByText("Reloading or rejoining does not bring old messages back.", { exact: true })).toBeVisible();
  await expect(page.getByText("410 Gone", { exact: true })).toBeVisible();
  await expect(page.locator(".security-page > .security-document > .security-header")).toHaveCount(1);
  const sourceLink = page.getByRole("link", { name: "Source code → GitHub", exact: true });
  await expect(sourceLink).toHaveAttribute("href", "https://github.com/norenX/410-chat");
  await expect(sourceLink).toHaveAttribute("target", "_blank");
  await expect(sourceLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Security →", exact: true })).toHaveAttribute("href", "/security");
  await expect(page.getByRole("link", { name: "Back →", exact: true })).toHaveAttribute("href", "/");

  const howDesktop = await informationPageLayout(page);
  expect(howDesktop.scrollWidth).toBeLessThanOrEqual(howDesktop.viewportWidth);

  await page.setViewportSize({ width: 390, height: 844 });
  const howMobile = await informationPageLayout(page);
  expect(howMobile.scrollWidth).toBeLessThanOrEqual(howMobile.viewportWidth);
  expect(howMobile.documentLeft).toBeGreaterThanOrEqual(20);
  expect(howMobile.documentRight).toBeLessThanOrEqual(howMobile.viewportWidth - 20);

  await page.getByRole("link", { name: "Back →", exact: true }).click();
  await expect(page).toHaveURL(baseURL!);
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "How it works →", exact: true }).click();
  await page.getByRole("link", { name: "Security →", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/security`);
  await expect(page.getByRole("heading", { level: 1, name: "Security", exact: true })).toBeVisible();
  await expect(page.locator(".security-page > .security-document > .security-header")).toHaveCount(1);

  const securityMobile = await informationPageLayout(page);
  expect(securityMobile).toEqual(howMobile);
  await page.setViewportSize({ width: 1440, height: 900 });
  const securityDesktop = await informationPageLayout(page);
  expect(securityDesktop).toEqual(howDesktop);

  expect((await page.request.get(`${baseURL}/admin/stats`)).status()).toBe(200);
});

test("home is inert; Start creates exactly one room and copies its one-time link", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") creates += 1;
  });

  await navigateDocument(page, baseURL!);
  await expect(page.getByRole("heading", { name: "One link. Two people. Gone." })).toBeVisible();
  expect(await page.locator(".start-headline > span").allTextContents()).toEqual(["One link.", "Two people.", "Gone."]);
  await expect(page.getByText("A private conversation that exists once.", { exact: false })).toBeVisible();
  await expect(page.getByText("1-to-1 private chat · 30 minutes", { exact: true })).toBeVisible();
  await expect(page.getByText("Experimental E2E · up to 10 people · 24 hours", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E encrypted · 2 people · 30 minutes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "How it works →", exact: true })).toHaveAttribute("href", "/how-it-works");
  await expect(page.getByRole("link", { name: "Security →", exact: true })).toBeVisible();
  await expect(page.locator(".start-page a")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Create a room", exact: true })).toBeVisible();
  await expect(page.locator(".start-page button")).toHaveCount(2);
  await expect(page.locator(".start-page nav")).toHaveCount(1);
  await expect(page.locator(".start-page footer, .start-page article")).toHaveCount(0);

  const desktop = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>(".start-page")!;
    const content = document.querySelector<HTMLElement>(".start-content")!;
    const logo = document.querySelector<HTMLElement>(".start-page .logo")!;
    const headline = document.querySelector<HTMLElement>(".start-headline")!;
    const intro = document.querySelector<HTMLElement>(".start-intro")!;
    const actions = document.querySelector<HTMLElement>(".start-actions")!;
    const start = document.querySelector<HTMLElement>(".primary-action")!;
    const descriptions = Array.from(document.querySelectorAll<HTMLElement>(".start-action p"));
    const information = document.querySelector<HTMLElement>(".start-information-links")!;
    const contentRect = content.getBoundingClientRect();
    const logoRect = logo.getBoundingClientRect();
    const headlineRect = headline.getBoundingClientRect();
    const introRect = intro.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const startRect = start.getBoundingClientRect();
    const informationRect = information.getBoundingClientRect();
    const pageStyle = getComputedStyle(pageElement);
    const startStyle = getComputedStyle(start);
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contentLeft: contentRect.left,
      contentTextAlign: getComputedStyle(content).textAlign,
      logoTop: logoRect.top,
      logoHeadlineGap: headlineRect.top - logoRect.bottom,
      leftEdges: [logoRect.left, headlineRect.left, introRect.left, startRect.left, ...descriptions.map((description) => description.getBoundingClientRect().left), informationRect.left],
      logoFontFamily: getComputedStyle(logo).fontFamily,
      headlineFontFamily: getComputedStyle(headline).fontFamily,
      logoSize: Number.parseFloat(getComputedStyle(logo).fontSize),
      headlineSize: Number.parseFloat(getComputedStyle(headline).fontSize),
      descriptionHeights: descriptions.map((description) => description.getBoundingClientRect().height),
      actionsSecurityGap: informationRect.top - actionsRect.bottom,
      background: pageStyle.backgroundColor,
      backgroundImage: pageStyle.backgroundImage,
      color: pageStyle.color,
      button: {
        width: startRect.width,
        height: startRect.height,
        background: startStyle.backgroundColor,
        color: startStyle.color
      }
    };
  });
  expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.viewportWidth);
  expect(desktop.contentLeft / desktop.viewportWidth).toBeGreaterThanOrEqual(.08);
  expect(desktop.contentLeft / desktop.viewportWidth).toBeLessThanOrEqual(.12);
  expect(desktop.contentTextAlign).toBe("left");
  expect(desktop.logoTop).toBeGreaterThanOrEqual(63);
  expect(desktop.logoTop).toBeLessThanOrEqual(100);
  expect(desktop.logoHeadlineGap).toBeGreaterThanOrEqual(40);
  expect(desktop.logoHeadlineGap).toBeLessThanOrEqual(60);
  expect(desktop.leftEdges.every((left) => Math.abs(left - desktop.contentLeft) < 1)).toBe(true);
  expect(desktop.logoFontFamily).toContain("monospace");
  expect(desktop.headlineFontFamily).not.toContain("monospace");
  expect(desktop.logoSize).toBeGreaterThanOrEqual(64);
  expect(desktop.logoSize).toBeLessThanOrEqual(76);
  expect(desktop.headlineSize).toBeGreaterThanOrEqual(56);
  expect(desktop.headlineSize).toBeLessThanOrEqual(68);
  expect(desktop.descriptionHeights.every((height) => height < 44)).toBe(true);
  expect(desktop.actionsSecurityGap).toBeGreaterThanOrEqual(20);
  expect(desktop.actionsSecurityGap).toBeLessThanOrEqual(36);
  expect(desktop.background).toBe("rgb(255, 255, 255)");
  expect(desktop.backgroundImage).toBe("none");
  expect(desktop.color).toBe("rgb(0, 0, 0)");
  expect(desktop.button.width).toBeGreaterThanOrEqual(280);
  expect(desktop.button.width).toBeLessThanOrEqual(320);
  expect(desktop.button.height).toBeGreaterThanOrEqual(56);
  expect(desktop.button.background).toBe("rgb(0, 0, 0)");
  expect(desktop.button.color).toBe("rgb(255, 255, 255)");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".start-content")!;
    const logo = document.querySelector<HTMLElement>(".start-page .logo")!;
    const headline = document.querySelector<HTMLElement>(".start-headline")!;
    const start = document.querySelector<HTMLElement>(".primary-action")!;
    const descriptions = Array.from(document.querySelectorAll<HTMLElement>(".start-action p"));
    const information = document.querySelector<HTMLElement>(".start-information-links")!;
    const security = document.querySelector<HTMLElement>(".start-security")!;
    const contentRect = content.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contentLeft: contentRect.left,
      contentWidth: contentRect.width,
      textAlign: getComputedStyle(content).textAlign,
      logoSize: Number.parseFloat(getComputedStyle(logo).fontSize),
      headlineRight: headline.getBoundingClientRect().right,
      buttonWidth: start.getBoundingClientRect().width,
      buttonRight: start.getBoundingClientRect().right,
      descriptionsRight: descriptions.map((description) => description.getBoundingClientRect().right),
      informationRight: information.getBoundingClientRect().right,
      securityRight: security.getBoundingClientRect().right
    };
  });
  expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(mobile.contentLeft).toBeGreaterThanOrEqual(20);
  expect(mobile.contentLeft).toBeLessThanOrEqual(28);
  expect(mobile.textAlign).toBe("left");
  expect(mobile.logoSize).toBeLessThan(desktop.logoSize);
  expect(mobile.headlineRight).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(Math.abs(mobile.buttonWidth - mobile.contentWidth)).toBeLessThan(1);
  expect(mobile.buttonRight).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(mobile.descriptionsRight.every((right) => right <= mobile.viewportWidth)).toBe(true);
  expect(mobile.informationRight).toBeLessThanOrEqual(mobile.viewportWidth);
  expect(mobile.securityRight).toBeLessThanOrEqual(mobile.viewportWidth);
  await page.waitForTimeout(250);
  expect(creates).toBe(0);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Link copied.")).toBeVisible();
  const invite = await page.getByLabel("One-time conversation link").inputValue();
  expect(invite).toMatch(new RegExp(`^${baseURL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/r/[A-Za-z0-9_-]{43}#secret=`));
  expect(await page.evaluate(() => (window as ClipboardWindow).__copiedInvite)).toBe(invite);
  expect(creates).toBe(1);
  await context.close();
});

test("home keeps direct parameters scoped when experimental group rooms are disabled", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/api/features", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ groupRooms: false }) });
  });
  await navigateDocument(page, baseURL!);

  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(page.getByText("1-to-1 private chat · 30 minutes", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a room", exact: true })).toHaveCount(0);
  await expect(page.getByText("Experimental E2E · up to 10 people · 24 hours", { exact: true })).toHaveCount(0);
  await expect(page.getByText("E2E encrypted · 2 people · 30 minutes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "How it works →", exact: true })).toHaveAttribute("href", "/how-it-works");
  await expect(page.getByRole("link", { name: "Security →", exact: true })).toBeVisible();

  const gap = await page.evaluate(() => {
    const actions = document.querySelector<HTMLElement>(".start-actions")!.getBoundingClientRect();
    const information = document.querySelector<HTMLElement>(".start-information-links")!.getBoundingClientRect();
    return information.top - actions.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(20);
  expect(gap).toBeLessThanOrEqual(36);
  await context.close();
});

test("a denied Clipboard API leaves the invite visible and manually selectable", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installDeniedClipboard(context);
  const page = await context.newPage();
  await navigateDocument(page, baseURL!);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Clipboard access is unavailable. Copy the link manually.")).toBeVisible();
  await expect(page.getByLabel("One-time conversation link")).toHaveValue(/\/r\/[A-Za-z0-9_-]{43}#secret=/);
  await context.close();
});

test("Waiting shows the exact existing invite as a local, accessible QR without network or lifecycle changes", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const observedRequests: string[] = [];
  page.on("request", (request) => observedRequests.push(request.url()));

  await navigateDocument(page, baseURL!);
  await expect(page.getByRole("button", { name: "Show QR", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-qr-value]")).toHaveCount(0);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Waiting for one person.")).toBeVisible();
  const invite = await page.getByLabel("One-time conversation link").inputValue();
  expect(invite).toContain("#secret=");
  const showQr = page.getByRole("button", { name: "Show QR", exact: true });
  await expect(showQr).toBeVisible();
  await expect(page.locator("[data-qr-value]")).toHaveCount(0);

  const statsBeforeResponse = await page.request.get(`${baseURL}/__stats`);
  const statsBefore = await statsBeforeResponse.json() as {
    now: { waiting: number; active: number };
    totals: { rooms_created: number };
  };
  const requestsBeforeShow = observedRequests.length;

  await showQr.click();
  const dialog = page.getByRole("dialog", { name: "QR invite" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Scan to join", exact: true })).toBeVisible();
  await expect(dialog.getByText("This invite can be used once.", { exact: true })).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  const qr = dialog.locator("svg.qr-code");
  await expect(qr).toHaveAttribute("data-qr-value", invite);
  await expect(qr).toHaveAttribute("data-quiet-zone", "4");
  await expect(qr.locator("path")).toHaveAttribute("d", /M/);
  await page.waitForTimeout(100);

  const mobileLayout = await page.evaluate(() => {
    const dialogElement = document.querySelector<HTMLElement>(".qr-dialog")!;
    const qrElement = document.querySelector<SVGElement>(".qr-code")!;
    const dialogRect = dialogElement.getBoundingClientRect();
    const qrRect = qrElement.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogWidth: dialogRect.width,
      qrLeft: qrRect.left,
      qrRight: qrRect.right,
      qrWidth: qrRect.width
    };
  });
  expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  expect(mobileLayout.dialogLeft).toBeGreaterThanOrEqual(20);
  expect(mobileLayout.dialogRight).toBeLessThanOrEqual(mobileLayout.viewportWidth - 20);
  expect(mobileLayout.dialogWidth).toBeLessThanOrEqual(360);
  expect(mobileLayout.qrLeft).toBeGreaterThanOrEqual(mobileLayout.dialogLeft);
  expect(mobileLayout.qrRight).toBeLessThanOrEqual(mobileLayout.dialogRight);
  expect(mobileLayout.qrWidth).toBeGreaterThanOrEqual(240);
  expect(observedRequests).toHaveLength(requestsBeforeShow);
  expect(observedRequests.every((url) => new URL(url).origin === new URL(baseURL!).origin)).toBe(true);
  expect(observedRequests.every((url) => !url.includes("#secret="))).toBe(true);

  const statsAfterResponse = await page.request.get(`${baseURL}/__stats`);
  const statsAfter = await statsAfterResponse.json() as typeof statsBefore;
  expect(statsAfter.totals.rooms_created).toBe(statsBefore.totals.rooms_created);
  expect(statsAfter.now).toEqual(statsBefore.now);

  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-qr-value]")).toHaveCount(0);
  await expect(showQr).toBeFocused();

  await showQr.click();
  await expect(page.getByRole("dialog", { name: "QR invite" }).locator("svg.qr-code")).toHaveAttribute("data-qr-value", invite);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "QR invite" })).toHaveCount(0);
  await expect(showQr).toBeFocused();

  const joinerContext = await browser.newContext();
  const joiner = await joinerContext.newPage();
  const joinerRequests: string[] = [];
  joiner.on("request", (request) => joinerRequests.push(request.url()));
  const inviteResponse = await navigateDocument(joiner, invite);
  expect(inviteResponse?.status()).toBe(200);
  await expect(page.locator("#message")).toBeEnabled();
  await expect(joiner.locator("#message")).toBeEnabled();
  expect(joinerRequests.every((url) => !url.includes("#secret="))).toBe(true);

  const consumedResponse = await joinerContext.request.get(invite);
  expect(consumedResponse.status()).toBe(410);
  await page.locator(".session-header").getByRole("button", { name: "Destroy" }).click();
  await page.getByRole("dialog", { name: "Destroy this conversation?" }).getByRole("button", { name: "Destroy" }).click();
  await waitForGone(page);
  await waitForGone(joiner);
  await context.close();
  await joinerContext.close();
});

test("Security modal links to a direct, refreshable, inert Security page", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const observedRequests: string[] = [];
  let creates = 0;
  page.on("request", (request) => {
    observedRequests.push(request.url());
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") creates += 1;
  });

  await navigateDocument(page, baseURL!);
  await page.getByRole("link", { name: "Security →", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Security" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  expect(await dialog.locator("p").innerText()).toBe([
    "Messages in 1-to-1 conversations and temporary rooms are encrypted in the browsers before being relayed.",
    "The server does not receive message plaintext.",
    "Other participants can still copy or record what they see."
  ].join("\n"));
  await expect(dialog.getByRole("link", { name: "Details →", exact: true })).toHaveAttribute("href", "/security");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();

  const beforeResponse = await page.request.get(`${baseURL}/__stats`);
  const before = await beforeResponse.json() as {
    now: { waiting: number; active: number };
    totals: Record<string, number>;
  };
  const [detailsResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    dialog.getByRole("link", { name: "Details →", exact: true }).click()
  ]);
  expect(detailsResponse?.status()).toBe(200);
  await expect(page).toHaveURL(`${baseURL}/security`);
  await expect(page).toHaveTitle("Security — 410");

  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: "Security", exact: true })).toBeVisible();
  expect(await page.locator("h2").allTextContents()).toEqual([
    "Messages",
    "What the server can see",
    "What is not kept",
    "Lifetime",
    "Temporary rooms (experimental)",
    "After destruction",
    "Analytics",
    "Limitations"
  ]);
  expect(await page.locator(".security-document p").allTextContents()).toEqual([
    "410 is designed for temporary conversations between browsers.",
    "Messages in 1-to-1 conversations and temporary rooms are end-to-end encrypted in the browsers before they are relayed.",
    "The server does not receive message plaintext or the session encryption keys.",
    "The server necessarily sees network metadata required to operate the service, including IP addresses, connection timing and encrypted network traffic.",
    "The relay also processes the protocol metadata necessary to establish and operate a conversation.",
    "410 does not keep conversation history, message plaintext, accounts or contact lists.",
    "Active rooms exist in server memory and disappear when they are destroyed, expire, or when the service process restarts.",
    "A 1-to-1 conversation has exactly two participants.",
    "An unused invite expires after 30 minutes.",
    "Once the second participant joins, the conversation can exist for up to 30 minutes.",
    "A consumed invite cannot be reused by another participant.",
    "If a participant disconnects, the conversation allows the existing reconnect grace period before it is destroyed.",
    "A room allows up to 10 people to be present at once and expires 24 hours after it is created.",
    "Its invite can be reused while the room exists. Only the creator capability can destroy it early.",
    "Room messages are not stored or replayed. A browser sees only messages sent while it is connected to the current live session.",
    "The encryption context changes when the active room membership changes.",
    "Group E2EE v1 is experimental, available only when explicitly enabled, and has not undergone an independent security review.",
    "When a conversation is gone, the room is no longer available.",
    "Requests to its conversation URL return HTTP 410 Gone.",
    "410 does not keep a conversation archive or a recoverable history of destroyed rooms.",
    "410 keeps aggregate service counters such as the number of rooms created, conversations started and encrypted chat messages relayed.",
    "These aggregate metrics may include a coarse traffic source such as Google or Pikabu, but never the full referrer URL. They do not contain message contents, room identifiers, invite tokens, user identifiers, IP addresses or User-Agent values.",
    "They are used to understand whether the service is functioning and being used.",
    "The other participant can copy, screenshot or record anything they receive.",
    "410 cannot prevent information from being saved outside the service.",
    "Because 410 is a web application, a compromised server could theoretically serve a modified client to a browser.",
    "The current cryptographic protocol has not undergone an independent security audit.",
    "410 should not be treated as a guarantee of anonymity."
  ]);
  await expect(page.getByRole("link", { name: "410", exact: true })).toHaveAttribute("href", "/");
  const sourceLink = page.getByRole("link", { name: "Source code → GitHub", exact: true });
  await expect(sourceLink).toHaveAttribute("href", "https://github.com/norenX/410-chat");
  await expect(sourceLink).toHaveAttribute("target", "_blank");
  await expect(sourceLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  await expect(page.locator("button, nav, footer, img, svg, canvas")).toHaveCount(0);

  const afterResponse = await page.request.get(`${baseURL}/__stats`);
  const after = await afterResponse.json() as typeof before;
  for (const metric of ["homepage_views", "rooms_created", "conversations_started", "messages_relayed"]) {
    expect(after.totals[metric]).toBe(before.totals[metric]);
  }
  expect(creates).toBe(0);
  expect(observedRequests.every((value) => new URL(value).origin === new URL(baseURL!).origin)).toBe(true);
  expect(await page.locator("script[src]").evaluateAll((scripts, origin) => scripts.every((script) =>
    new URL((script as HTMLScriptElement).src).origin === origin
  ), new URL(baseURL!).origin)).toBe(true);

  const refreshed = await page.reload({ waitUntil: "domcontentloaded" });
  expect(refreshed?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Security", exact: true })).toBeVisible();

  const directContext = await browser.newContext();
  const directPage = await directContext.newPage();
  const directResponse = await navigateDocument(directPage, `${baseURL}/security`);
  expect(directResponse?.status()).toBe(200);
  await expect(directPage.getByRole("heading", { level: 1, name: "Security", exact: true })).toBeVisible();
  await directPage.setViewportSize({ width: 390, height: 844 });
  const layout = await directPage.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>(".security-page")!;
    const documentElement = document.querySelector<HTMLElement>(".security-document")!;
    const pageStyle = getComputedStyle(pageElement);
    const documentRect = documentElement.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contentLeft: documentRect.left,
      contentRight: documentRect.right,
      background: pageStyle.backgroundColor,
      backgroundImage: pageStyle.backgroundImage
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.contentLeft).toBeGreaterThanOrEqual(20);
  expect(layout.contentLeft).toBeLessThanOrEqual(28);
  expect(layout.contentRight).toBeLessThanOrEqual(layout.viewportWidth - 20);
  expect(layout.background).toBe("rgb(255, 255, 255)");
  expect(layout.backgroundImage).toBe("none");

  await directContext.close();
  await context.close();
});

test("three contexts use a reusable no-history E2E room, rekey on membership changes, and end at HTTP 410", async ({ browser, baseURL }) => {
  const creatorContext = await browser.newContext();
  await installWorkingClipboard(creatorContext);
  const creator = await creatorContext.newPage();
  const sentFrames: string[] = [];
  creator.on("websocket", (socket) => {
    socket.on("framesent", (frame) => sentFrames.push(String(frame.payload)));
  });
  const before = await (await creator.request.get(`${baseURL}/__stats`)).json() as {
    groups: { totals: Record<string, number> };
  };

  await navigateDocument(creator, baseURL!);
  await creator.getByRole("button", { name: "Create a room", exact: true }).click();
  await expect(creator).toHaveURL(/\/g\/[A-Za-z0-9_-]{43}$/);
  await expect(creator.getByText("1 person here", { exact: true })).toBeVisible();
  await expect(creator.locator(".group-presence-event")).toHaveCount(0);
  const creatorPersona = await creator.locator(".group-self-persona strong").textContent();
  expect(creatorPersona).toBeTruthy();
  const inviteInput = creator.getByLabel("Reusable room link");
  await expect(inviteInput).toBeVisible();
  const invite = await inviteInput.inputValue();
  expect(invite).toMatch(new RegExp(`^${baseURL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/g/[A-Za-z0-9_-]{43}#secret=`));
  const ownerCapability = await creator.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { ownerCapability?: string } | null;
    return session?.ownerCapability;
  });
  expect(ownerCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(invite).not.toContain(ownerCapability!);

  await creator.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await creator.evaluate(() => (window as ClipboardWindow).__copiedInvite)).toBe(invite);
  const qrTrigger = creator.getByRole("button", { name: "Show QR", exact: true });
  await qrTrigger.click();
  const qrDialog = creator.getByRole("dialog", { name: "QR invite" });
  await expect(qrDialog.getByText("This invite works while the room exists.", { exact: true })).toBeVisible();
  await expect(qrDialog.locator("svg.qr-code")).toHaveAttribute("data-qr-value", invite);
  await qrDialog.getByRole("button", { name: "Close" }).click();

  const bContext = await browser.newContext();
  const b = await bContext.newPage();
  await openGroupInvite(b, invite);
  await expect(creator.getByText("2 people here", { exact: true })).toBeVisible();
  await expect(creator.locator("#group-message")).toBeEnabled();
  await expect(b.locator("#group-message")).toBeEnabled();
  const bPersona = (await b.locator(".group-self-persona strong").textContent())!;
  await expect(creator.getByText(`${bPersona} joined`, { exact: true })).toHaveCount(1);
  await expect(b.locator(".group-presence-event")).toHaveCount(0);

  const creatorComposer = creator.locator("#group-message");
  await creator.bringToFront();
  await creatorComposer.fill("before third participant");
  await creatorComposer.press("Enter");
  await expect(creatorComposer).toHaveValue("");
  await expect(b.getByText("before third participant", { exact: true })).toBeVisible();
  await expect(b.locator(".group-message-author").filter({ hasText: creatorPersona! })).toBeVisible();

  const cContext = await browser.newContext();
  const c = await cContext.newPage();
  await openGroupInvite(c, invite);
  await expect(creator.getByText("3 people here", { exact: true })).toBeVisible();
  await expect(c.locator("#group-message")).toBeEnabled();
  await expect(c.getByText("before third participant", { exact: true })).toHaveCount(0);
  const cPersona = (await c.locator(".group-self-persona strong").textContent())!;
  await expect(creator.getByText(`${cPersona} joined`, { exact: true })).toHaveCount(1);
  await expect(b.getByText(`${cPersona} joined`, { exact: true })).toHaveCount(1);
  await expect(c.locator(".group-presence-event")).toHaveCount(0);

  await creator.bringToFront();
  await creatorComposer.fill("after third participant");
  await creator.getByRole("button", { name: "Send", exact: true }).click();
  await expect(creatorComposer).toHaveValue("");
  await expect(b.getByText("after third participant", { exact: true })).toBeVisible();
  await expect(c.getByText("after third participant", { exact: true })).toBeVisible();
  expect(sentFrames.join("\n")).not.toContain("before third participant");
  expect(sentFrames.join("\n")).not.toContain("after third participant");

  await cContext.close();
  await expect(creator.getByText("3 people here", { exact: true })).toBeVisible();
  await creator.waitForTimeout(500);
  await expect(creator.getByText(`${cPersona} left`, { exact: true })).toHaveCount(0);
  await expect(creator.getByText("2 people here", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(creator.getByText(`${cPersona} left`, { exact: true })).toHaveCount(1);
  await expect(b.getByText(`${cPersona} left`, { exact: true })).toHaveCount(1);

  const rejoinContext = await browser.newContext();
  const rejoined = await rejoinContext.newPage();
  await openGroupInvite(rejoined, invite);
  await expect(creator.getByText("3 people here", { exact: true })).toBeVisible();
  await expect(rejoined.locator("#group-message")).toBeEnabled();
  await expect(rejoined.locator(".message")).toHaveCount(0);
  const rejoinedPersona = (await rejoined.locator(".group-self-persona strong").textContent())!;
  await expect(creator.getByText(`${rejoinedPersona} joined`, { exact: true })).toHaveCount(1);
  await expect(b.getByText(`${rejoinedPersona} joined`, { exact: true })).toHaveCount(1);
  await expect(rejoined.locator(".group-presence-event")).toHaveCount(0);
  await b.locator("#group-message").fill("after rejoin only");
  await b.locator("#group-message").press("Enter");
  await expect(creator.getByText("after rejoin only", { exact: true })).toBeVisible();
  await expect(rejoined.getByText("after rejoin only", { exact: true })).toBeVisible();

  const memberBeforeReload = await creator.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { memberId?: string } | null;
    return session?.memberId;
  });
  await expect(b.getByText(`${creatorPersona} left`, { exact: true })).toHaveCount(0);
  await expect(b.getByText(`${creatorPersona} joined`, { exact: true })).toHaveCount(0);
  await creator.reload({ waitUntil: "domcontentloaded" });
  await expect(creator.locator("#group-message")).toBeEnabled({ timeout: 10_000 });
  await expect(creator.locator(".message")).toHaveCount(0);
  await expect(creator.locator(".group-self-persona strong")).toHaveText(creatorPersona!);
  const memberAfterReload = await creator.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { memberId?: string } | null;
    return session?.memberId;
  });
  expect(memberAfterReload).toBeTruthy();
  expect(memberAfterReload).not.toBe(memberBeforeReload);
  await expect(b.getByText(`${creatorPersona} left`, { exact: true })).toHaveCount(0);
  await expect(b.getByText(`${creatorPersona} joined`, { exact: true })).toHaveCount(0);
  await expect(creator.getByRole("button", { name: "Destroy room", exact: true })).toBeVisible();

  const after = await (await creator.request.get(`${baseURL}/__stats`)).json() as typeof before;
  expect(after.groups.totals.group_rooms_created - before.groups.totals.group_rooms_created).toBe(1);
  expect(after.groups.totals.group_participants_joined - before.groups.totals.group_participants_joined).toBe(5);
  expect(after.groups.totals.group_conversations_started - before.groups.totals.group_conversations_started).toBe(1);
  expect(after.groups.totals.group_messages_relayed - before.groups.totals.group_messages_relayed).toBe(3);

  await creator.evaluate(() => {
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function sendWithOneRelayFailure(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === "string" && data.includes('"type":"group_relay"')) {
        WebSocket.prototype.send = originalSend;
        throw new Error("simulated group relay send failure");
      }
      return originalSend.call(this, data);
    };
  });
  await creatorComposer.fill("keep this failed message");
  await creatorComposer.press("Enter");
  await expect(creatorComposer).toHaveValue("keep this failed message");
  await expect(creatorComposer).toBeDisabled();
  await expect(creatorComposer).toBeEnabled({ timeout: 10_000 });
  await expect(creatorComposer).toHaveValue("keep this failed message");
  await expect(creatorComposer).not.toBeFocused();
  await creatorComposer.fill("");

  await creator.getByRole("button", { name: "Destroy room", exact: true }).click();
  const confirm = creator.getByRole("dialog", { name: "Destroy this room?" });
  await expect(confirm).toBeVisible();
  const creatorGone = creator.waitForResponse((response) => response.status() === 410 && response.request().resourceType() === "document");
  const bGone = b.waitForResponse((response) => response.status() === 410 && response.request().resourceType() === "document");
  const rejoinedGone = rejoined.waitForResponse((response) => response.status() === 410 && response.request().resourceType() === "document");
  await confirm.getByRole("button", { name: "Destroy room", exact: true }).click();
  expect((await creatorGone).status()).toBe(410);
  expect((await bGone).status()).toBe(410);
  expect((await rejoinedGone).status()).toBe(410);
  await waitForGone(creator);
  await waitForGone(b);
  await waitForGone(rejoined);
  const stale = await creatorContext.request.get(invite);
  expect(stale.status()).toBe(410);
  expect(stale.headers()["cache-control"]).toBe("no-store");
  expect(stale.headers()["x-robots-tag"]).toBe("noindex, nofollow");

  await creatorContext.close();
  await bContext.close();
  await rejoinContext.close();
});

test("room personas persist per browser while tabs remain separate live participants", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const primary = await context.newPage();
  await navigateDocument(primary, baseURL!);
  await primary.getByRole("button", { name: "Create a room", exact: true }).click();
  await expect(primary.getByText("1 person here", { exact: true })).toBeVisible();
  const invite = await primary.getByLabel("Reusable room link").inputValue();
  const primaryName = (await primary.locator(".group-self-persona strong").textContent())!;
  const primaryStyle = await primary.locator(".group-self-persona strong").getAttribute("style");
  const owner = await primary.evaluate(() => {
    return JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as {
      roomId: string;
      memberId: string;
      ownerCapability: string;
    };
  });
  const ownerRecoverySecret = await primary.evaluate(() => {
    const entry = Object.entries(localStorage).find(([key]) => key.startsWith("410.group.owner-recovery.v1."));
    return entry?.[1];
  });
  expect(ownerRecoverySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(invite).not.toContain(ownerRecoverySecret!);
  expect(await primary.evaluate((secret) => sessionStorage.getItem("410.group.session.v1")?.includes(secret) ?? false, ownerRecoverySecret!)).toBe(false);
  await expect(primary.getByRole("button", { name: "Destroy room", exact: true })).toBeVisible();

  const secondTab = await context.newPage();
  await openGroupInvite(secondTab, invite);
  await expect(secondTab.locator("#group-message")).toBeEnabled();
  const secondName = (await secondTab.locator(".group-self-persona strong").textContent())!;
  expect(secondName).not.toBe(primaryName);
  await expect(secondTab.getByRole("button", { name: "Destroy room", exact: true })).toHaveCount(0);
  await expect(primary.getByText(`${secondName} joined`, { exact: true })).toHaveCount(1);
  await expect(secondTab.locator(".group-presence-event")).toHaveCount(0);

  const thirdTab = await context.newPage();
  await openGroupInvite(thirdTab, invite);
  await expect(thirdTab.locator("#group-message")).toBeEnabled();
  const thirdName = (await thirdTab.locator(".group-self-persona strong").textContent())!;
  await expect(thirdTab.getByRole("button", { name: "Destroy room", exact: true })).toHaveCount(0);
  await expect(primary.getByText(`${thirdName} joined`, { exact: true })).toHaveCount(1);
  await expect(secondTab.getByText(`${thirdName} joined`, { exact: true })).toHaveCount(1);
  await expect(thirdTab.locator(".group-presence-event")).toHaveCount(0);

  const rejectedTab = await context.newPage();
  await openGroupInvite(rejectedTab, invite);
  await expect(rejectedTab.getByRole("heading", { name: "Too many sessions from this browser." })).toBeVisible();
  await expect(primary.getByText("3 people here", { exact: true })).toBeVisible();

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await openGroupInvite(other, invite);
  await expect(other.locator("#group-message")).toBeEnabled();
  const otherName = (await other.locator(".group-self-persona strong").textContent())!;
  await expect(other.getByRole("button", { name: "Destroy room", exact: true })).toHaveCount(0);
  await expect(primary.getByText(`${otherName} joined`, { exact: true })).toHaveCount(1);
  await expect(secondTab.getByText(`${otherName} joined`, { exact: true })).toHaveCount(1);
  await expect(thirdTab.getByText(`${otherName} joined`, { exact: true })).toHaveCount(1);
  await expect(other.locator(".group-presence-event")).toHaveCount(0);
  const names = [primaryName, secondName, thirdName, otherName];
  expect(new Set(names).size).toBe(4);
  const styles = await Promise.all([primary, secondTab, thirdTab, other].map((page) =>
    page.locator(".group-self-persona strong").getAttribute("style")
  ));
  expect(new Set(styles).size).toBe(4);

  await primary.locator("#group-message").fill("persona-labelled message");
  await primary.locator("#group-message").press("Enter");
  await expect(other.getByText("persona-labelled message", { exact: true })).toBeVisible();
  const author = other.locator(".group-message-author", { hasText: primaryName });
  await expect(author).toBeVisible();
  expect(await author.getAttribute("style")).toBe(primaryStyle);

  const memberBeforeReload = owner.memberId;
  await expect(other.getByText(`${primaryName} left`, { exact: true })).toHaveCount(0);
  await expect(other.getByText(`${primaryName} joined`, { exact: true })).toHaveCount(0);
  await primary.reload({ waitUntil: "domcontentloaded" });
  await expect(primary.locator("#group-message")).toBeEnabled({ timeout: 10_000 });
  await expect(primary.locator(".group-self-persona strong")).toHaveText(primaryName);
  await expect(primary.locator(".message")).toHaveCount(0);
  const memberAfterReload = await primary.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { memberId?: string } | null;
    return session?.memberId;
  });
  expect(memberAfterReload).not.toBe(memberBeforeReload);
  await expect(other.getByText(`${primaryName} left`, { exact: true })).toHaveCount(0);
  await expect(other.getByText(`${primaryName} joined`, { exact: true })).toHaveCount(0);

  await primary.close();
  const returnedPrimary = await context.newPage();
  await openGroupInvite(returnedPrimary, invite);
  await expect(returnedPrimary.locator("#group-message")).toBeEnabled({ timeout: 10_000 });
  await expect(returnedPrimary.locator(".group-self-persona strong")).toHaveText(primaryName);
  await expect(returnedPrimary.locator(".message")).toHaveCount(0);
  const returnedMemberId = await returnedPrimary.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { memberId?: string } | null;
    return session?.memberId;
  });
  expect(returnedMemberId).not.toBe(memberAfterReload);
  await expect(returnedPrimary.getByRole("button", { name: "Destroy room", exact: true })).toBeVisible();
  const recoveredOwnerCapability = await returnedPrimary.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { ownerCapability?: string } | null;
    return session?.ownerCapability;
  });
  expect(recoveredOwnerCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(recoveredOwnerCapability).not.toBe(owner.ownerCapability);

  await secondTab.close();
  await expect(returnedPrimary.getByText("3 people here", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(returnedPrimary.getByText(`${secondName} left`, { exact: true })).toHaveCount(1);
  const replacementEphemeral = await context.newPage();
  await openGroupInvite(replacementEphemeral, invite);
  await expect(replacementEphemeral.locator("#group-message")).toBeEnabled({ timeout: 10_000 });
  const replacementName = (await replacementEphemeral.locator(".group-self-persona strong").textContent())!;
  expect(replacementName).not.toBe(secondName);
  await expect(returnedPrimary.getByText(`${replacementName} joined`, { exact: true })).toHaveCount(1);
  await expect(replacementEphemeral.locator(".group-presence-event")).toHaveCount(0);
  await expect(replacementEphemeral.locator(".message")).toHaveCount(0);

  const gone = returnedPrimary.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  await returnedPrimary.evaluate(({ roomId, ownerCapability }) => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/group-ws`);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "group_owner_destroy",
      roomId,
      ownerCapability
    })));
  }, { roomId: owner.roomId, ownerCapability: recoveredOwnerCapability! });
  expect((await gone).status()).toBe(410);
  await waitForGone(returnedPrimary);
  expect(await returnedPrimary.evaluate(() =>
    Object.keys(localStorage).some((key) => key.startsWith("410.group.browser.v1."))
  )).toBe(false);
  expect(await returnedPrimary.evaluate(() =>
    Object.keys(localStorage).some((key) => key.startsWith("410.group.owner-recovery.v1."))
  )).toBe(false);

  await context.close();
  await otherContext.close();
});

test("group transport resume inside grace does not emit presence noise", async ({ browser, baseURL }) => {
  const creatorContext = await browser.newContext();
  await installWorkingClipboard(creatorContext);
  const participantContext = await browser.newContext();
  await participantContext.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const TrackedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        if (String(args[0]).endsWith("/group-ws")) {
          (window as Window & { __groupTestSocket?: WebSocket }).__groupTestSocket = socket;
        }
        return socket;
      }
    });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: TrackedWebSocket });
  });
  const creator = await creatorContext.newPage();
  const participant = await participantContext.newPage();

  await navigateDocument(creator, baseURL!);
  await creator.getByRole("button", { name: "Create a room", exact: true }).click();
  const invite = await creator.getByLabel("Reusable room link").inputValue();
  await openGroupInvite(participant, invite);
  await expect(creator.locator("#group-message")).toBeEnabled();
  await expect(participant.locator("#group-message")).toBeEnabled();
  const participantName = (await participant.locator(".group-self-persona strong").textContent())!;
  await expect(creator.getByText(`${participantName} joined`, { exact: true })).toHaveCount(1);
  const resumeTokenBefore = await participant.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { resumeToken?: string } | null;
    return session?.resumeToken;
  });

  await participant.evaluate(() => {
    (window as Window & { __groupTestSocket?: WebSocket }).__groupTestSocket?.close(4499, "test transport drop");
  });
  await participant.waitForTimeout(400);
  await expect(creator.getByText(`${participantName} left`, { exact: true })).toHaveCount(0);
  await expect.poll(async () => participant.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem("410.group.session.v1") || "null") as { resumeToken?: string } | null;
    return session?.resumeToken;
  }), { timeout: 10_000 }).not.toBe(resumeTokenBefore);
  await expect(participant.locator("#group-message")).toBeEnabled({ timeout: 10_000 });
  await expect(creator.getByText("2 people here", { exact: true })).toBeVisible();
  await expect(creator.getByText(`${participantName} joined`, { exact: true })).toHaveCount(1);
  await expect(creator.getByText(`${participantName} left`, { exact: true })).toHaveCount(0);
  await expect(participant.locator(".group-presence-event")).toHaveCount(0);

  const creatorGone = creator.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  const participantGone = participant.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  await creator.getByRole("button", { name: "Destroy room", exact: true }).click();
  await creator.getByRole("dialog", { name: "Destroy this room?" })
    .getByRole("button", { name: "Destroy room", exact: true }).click();
  expect((await creatorGone).status()).toBe(410);
  expect((await participantGone).status()).toBe(410);
  await waitForGone(creator);
  await waitForGone(participant);

  await creatorContext.close();
  await participantContext.close();
});

test("group composer keeps focus after Enter and click Send", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const creator = await context.newPage();
  await navigateDocument(creator, baseURL!);
  await creator.getByRole("button", { name: "Create a room", exact: true }).click();
  const invite = await creator.getByLabel("Reusable room link").inputValue();

  const peer = await context.newPage();
  await openGroupInvite(peer, invite);
  await expect(peer.locator("#group-message")).toBeEnabled();
  await creator.bringToFront();

  const composer = creator.locator("#group-message");
  await composer.fill("sent with Enter");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await expect(peer.getByText("sent with Enter", { exact: true })).toBeVisible();

  await composer.fill("sent with click");
  await creator.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await expect(peer.getByText("sent with click", { exact: true })).toBeVisible();

  const creatorGone = creator.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  const peerGone = peer.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  await creator.getByRole("button", { name: "Destroy room", exact: true }).click();
  await creator.getByRole("dialog", { name: "Destroy this room?" })
    .getByRole("button", { name: "Destroy room", exact: true }).click();
  expect((await creatorGone).status()).toBe(410);
  expect((await peerGone).status()).toBe(410);
  await context.close();
});

test("Firefox accepts a real fragment invite, strips it, and exchanges an encrypted message", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "firefox", "Firefox-specific fragment navigation smoke coverage");
  const creatorContext = await browser.newContext();
  await installWorkingClipboard(creatorContext);
  const creator = await creatorContext.newPage();
  await navigateDocument(creator, baseURL!);
  await creator.getByRole("button", { name: "Create a room", exact: true }).click();
  const invite = await creator.getByLabel("Reusable room link").inputValue();
  expect(new URL(invite).hash).toMatch(/^#secret=[A-Za-z0-9_-]{43}$/);

  const joinerContext = await browser.newContext();
  const joiner = await joinerContext.newPage();
  const inviteResponse = await navigateDocument(joiner, invite);
  expect(inviteResponse?.status()).toBe(200);
  await expect.poll(() => new URL(joiner.url()).hash, { timeout: 15_000 }).toBe("");
  await expect(joiner.locator("#group-message")).toBeEnabled({ timeout: 15_000 });
  await expect(creator.locator("#group-message")).toBeEnabled({ timeout: 15_000 });
  await joiner.locator("#group-message").fill("real Firefox fragment flow");
  await joiner.locator("#group-message").press("Enter");
  await expect(creator.getByText("real Firefox fragment flow", { exact: true })).toBeVisible();

  await creator.getByRole("button", { name: "Destroy room", exact: true }).click();
  await creator.getByRole("dialog", { name: "Destroy this room?" })
    .getByRole("button", { name: "Destroy room", exact: true }).click();
  await waitForGone(creator);
  await waitForGone(joiner);
  await creatorContext.close();
  await joinerContext.close();
});

test("Firefox shows the direct disconnect grace countdown in the foreground tab", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "firefox", "Firefox-specific foreground disconnect coverage");
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const creator = await context.newPage();
  await navigateDocument(creator, baseURL!);
  await creator.getByRole("button", { name: "Start" }).click();
  const invite = await creator.getByLabel("One-time conversation link").inputValue();

  const joiner = await context.newPage();
  expect((await navigateDocument(joiner, invite)).status()).toBe(200);
  await expect(creator.locator("#message")).toBeEnabled();
  await expect(joiner.locator("#message")).toBeEnabled();
  await creator.bringToFront();

  const goneResponse = creator.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  const closeJoiner = joiner.close();
  await expect(creator.getByText("Connection lost.")).toBeVisible();
  await expect(creator.getByText(/This conversation will be gone in 00:0[1-5]/)).toBeVisible();
  await closeJoiner;
  expect((await goneResponse).status()).toBe(410);
  await waitForGone(creator);
  await context.close();
});

test("two contexts exchange E2E messages; consumed invite is HTTP 410; disconnect burns the room", async ({ browser, browserName, baseURL }) => {
  const pair = await createActivePair(browser, baseURL!);

  await pair.creator.locator("#message").fill("hello from the creator browser");
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.getByText("hello from the creator browser")).toBeVisible();
  await pair.joiner.locator("#message").fill("hello from the joiner browser");
  await pair.joiner.locator("#message").press("Enter");
  await expect(pair.creator.getByText("hello from the joiner browser")).toBeVisible();

  const thirdContext = await browser.newContext();
  const consumedResponse = await thirdContext.request.get(pair.invite);
  expect(consumedResponse.status()).toBe(410);
  expect(consumedResponse.headers()["cache-control"]).toBe("no-store");
  expect(consumedResponse.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(await consumedResponse.text()).toContain("<h1>410 Gone</h1>");
  await thirdContext.close();

  const goneResponse = pair.creator.waitForResponse((response) =>
    response.status() === 410 && response.request().resourceType() === "document"
  );
  await pair.creator.bringToFront();
  const closeJoiner = pair.joinerContext.close();
  if (browserName !== "firefox") {
    await expect(pair.creator.getByText("Connection lost.")).toBeVisible();
    await expect(pair.creator.getByText(/This conversation will be gone in 00:0[1-5]/)).toBeVisible();
  }
  await closeJoiner;
  expect((await goneResponse).status()).toBe(410);
  await waitForGone(pair.creator);
  await expect(pair.creator.getByText("hello from the joiner browser")).toHaveCount(0);

  const refreshed = await pair.creator.reload();
  expect(refreshed?.status()).toBe(410);
  await waitForGone(pair.creator);
  await pair.creator.goBack().catch(() => null);
  await expect(pair.creator.getByText("hello from the joiner browser")).toHaveCount(0);
  await pair.creatorContext.close();
});

test("Destroy requires confirmation and sends both browsers to a real HTTP 410 dead end", async ({ browser, baseURL }) => {
  const pair = await createActivePair(browser, baseURL!);
  await pair.creator.locator(".session-header").getByRole("button", { name: "Destroy" }).click();
  const dialog = pair.creator.getByRole("dialog", { name: "Destroy this conversation?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(pair.creator.locator("#message")).toBeEnabled();

  await pair.creator.locator(".session-header").getByRole("button", { name: "Destroy" }).click();
  const creatorGone = pair.creator.waitForResponse((response) => response.status() === 410 && response.request().resourceType() === "document");
  const joinerGone = pair.joiner.waitForResponse((response) => response.status() === 410 && response.request().resourceType() === "document");
  await pair.creator.getByRole("dialog", { name: "Destroy this conversation?" }).getByRole("button", { name: "Destroy" }).click();
  expect((await creatorGone).status()).toBe(410);
  expect((await joinerGone).status()).toBe(410);
  await waitForGone(pair.creator);
  await waitForGone(pair.joiner);

  const staleResponse = await pair.creator.request.get(pair.invite);
  expect(staleResponse.status()).toBe(410);
  expect(staleResponse.headers()["cache-control"]).toBe("no-store");
  expect(staleResponse.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await pair.creatorContext.close();
  await pair.joinerContext.close();
});

test("unknown non-room routes remain 404", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/foobar`);
  expect(response.status()).toBe(404);
});

test("Conversation locks the viewport, scrolls only messages, and preserves manual scroll intent", async ({ browser, baseURL }) => {
  const pair = await createActivePair(browser, baseURL!);
  await pair.creator.setViewportSize({ width: 1440, height: 900 });
  await pair.joiner.setViewportSize({ width: 1440, height: 900 });

  const peerMessageCount = await pair.joiner.locator(".message").count();
  await pair.creator.locator("#message").fill("first line");
  await pair.creator.locator("#message").press("Shift+Enter");
  await expect(pair.creator.locator("#message")).toHaveValue("first line\n");
  await expect(pair.joiner.locator(".message")).toHaveCount(peerMessageCount);

  await pair.creator.locator("#message").fill("   ");
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.locator(".message")).toHaveCount(peerMessageCount);

  await pair.creator.locator("#message").fill("sent with Enter");
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.getByText("sent with Enter")).toBeVisible();

  await sendMessages(pair.creator, 110, "layout message");
  await expect(pair.joiner.getByText("layout message 109", { exact: true })).toBeVisible();
  await expect.poll(() => pair.joiner.locator(".message").count()).toBe(111);

  const desktop = await conversationMetrics(pair.joiner);
  expectViewportLocked(desktop);
  await expect.poll(async () => pair.joiner.locator(".message-list").evaluate((list) =>
    list.scrollHeight - list.scrollTop - list.clientHeight
  )).toBeLessThanOrEqual(2);

  const longWord = `long-${"x".repeat(1800)}`;
  await pair.creator.locator("#message").fill(longWord);
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.getByText(longWord)).toBeAttached();
  const afterLongWord = await conversationMetrics(pair.joiner);
  expect(afterLongWord.messages.scrollWidth).toBeLessThanOrEqual(afterLongWord.messages.clientWidth + 1);
  expect(afterLongWord.documentWidth).toBeLessThanOrEqual(afterLongWord.viewport.width + 1);

  const scrolledUp = await pair.joiner.locator(".message-list").evaluate((list) => {
    list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 500);
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
    return list.scrollTop;
  });
  await pair.creator.locator("#message").fill("do not pull me down");
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.getByText("do not pull me down")).toBeAttached();
  await pair.joiner.waitForTimeout(100);
  const preserved = await pair.joiner.locator(".message-list").evaluate((list) => list.scrollTop);
  expect(Math.abs(preserved - scrolledUp)).toBeLessThanOrEqual(2);

  await pair.joiner.locator(".message-list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await pair.creator.locator("#message").fill("follow the bottom");
  await pair.creator.locator("#message").press("Enter");
  await expect(pair.joiner.getByText("follow the bottom")).toBeVisible();
  await expect.poll(async () => pair.joiner.locator(".message-list").evaluate((list) =>
    list.scrollHeight - list.scrollTop - list.clientHeight
  )).toBeLessThanOrEqual(2);

  await pair.joiner.setViewportSize({ width: 390, height: 844 });
  const mobile = await conversationMetrics(pair.joiner);
  expectViewportLocked(mobile);
  await expect(pair.joiner.locator(".session-header")).toBeVisible();
  await expect(pair.joiner.locator(".composer")).toBeVisible();

  await pair.creator.locator(".session-header").getByRole("button", { name: "Destroy" }).click();
  await pair.creator.getByRole("dialog", { name: "Destroy this conversation?" }).getByRole("button", { name: "Destroy" }).click();
  await waitForGone(pair.creator);
  await waitForGone(pair.joiner);
  await pair.creatorContext.close();
  await pair.joinerContext.close();
});
