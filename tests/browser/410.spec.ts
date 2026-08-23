import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

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

async function createActivePair(browser: Browser, baseURL: string) {
  const creatorContext = await browser.newContext();
  await installWorkingClipboard(creatorContext);
  const joinerContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();

  await creator.goto(baseURL, { waitUntil: "domcontentloaded" });
  await creator.getByRole("button", { name: "Start" }).click();
  await expect(creator.getByText("Waiting for one person.")).toBeVisible();
  const invite = await creator.getByLabel("One-time conversation link").inputValue();

  const inviteResponse = await joiner.goto(invite, { waitUntil: "commit" });
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

test("home is inert; Start creates exactly one room and copies its one-time link", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installWorkingClipboard(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") creates += 1;
  });

  await page.goto(baseURL!);
  await expect(page.getByRole("heading", { name: "One link. Two people. Gone." })).toBeVisible();
  expect(await page.locator(".start-headline > span").allTextContents()).toEqual(["One link.", "Two people.", "Gone."]);
  await expect(page.getByText("A private conversation that exists once.", { exact: false })).toBeVisible();
  await expect(page.getByText("E2E encrypted · 2 people · 30 minutes", { exact: true })).toBeVisible();
  await expect(page.getByText("How it works", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Security →", exact: true })).toBeVisible();
  await expect(page.locator(".start-page a")).toHaveCount(1);
  await expect(page.locator(".start-page button")).toHaveCount(1);
  await expect(page.locator(".start-page nav, .start-page footer, .start-page article")).toHaveCount(0);

  const desktop = await page.evaluate(() => {
    const pageElement = document.querySelector<HTMLElement>(".start-page")!;
    const content = document.querySelector<HTMLElement>(".start-content")!;
    const logo = document.querySelector<HTMLElement>(".start-page .logo")!;
    const headline = document.querySelector<HTMLElement>(".start-headline")!;
    const intro = document.querySelector<HTMLElement>(".start-intro")!;
    const start = document.querySelector<HTMLElement>(".primary-action")!;
    const technical = document.querySelector<HTMLElement>(".start-technical")!;
    const security = document.querySelector<HTMLElement>(".start-security")!;
    const contentRect = content.getBoundingClientRect();
    const logoRect = logo.getBoundingClientRect();
    const headlineRect = headline.getBoundingClientRect();
    const introRect = intro.getBoundingClientRect();
    const startRect = start.getBoundingClientRect();
    const technicalRect = technical.getBoundingClientRect();
    const securityRect = security.getBoundingClientRect();
    const pageStyle = getComputedStyle(pageElement);
    const startStyle = getComputedStyle(start);
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contentLeft: contentRect.left,
      contentTextAlign: getComputedStyle(content).textAlign,
      logoTop: logoRect.top,
      logoHeadlineGap: headlineRect.top - logoRect.bottom,
      leftEdges: [logoRect.left, headlineRect.left, introRect.left, startRect.left, technicalRect.left, securityRect.left],
      logoFontFamily: getComputedStyle(logo).fontFamily,
      headlineFontFamily: getComputedStyle(headline).fontFamily,
      logoSize: Number.parseFloat(getComputedStyle(logo).fontSize),
      headlineSize: Number.parseFloat(getComputedStyle(headline).fontSize),
      technicalHeight: technicalRect.height,
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
  expect(desktop.technicalHeight).toBeLessThan(30);
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
    const technical = document.querySelector<HTMLElement>(".start-technical")!;
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
      technicalRight: technical.getBoundingClientRect().right
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
  expect(mobile.technicalRight).toBeLessThanOrEqual(mobile.viewportWidth);
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

test("a denied Clipboard API leaves the invite visible and manually selectable", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  await installDeniedClipboard(context);
  const page = await context.newPage();
  await page.goto(baseURL!);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Clipboard access is unavailable. Copy the link manually.")).toBeVisible();
  await expect(page.getByLabel("One-time conversation link")).toHaveValue(/\/r\/[A-Za-z0-9_-]{43}#secret=/);
  await context.close();
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

  await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Security →", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Security" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  expect(await dialog.locator("p").innerText()).toBe([
    "Messages are encrypted in the browsers before being relayed.",
    "The server does not receive message plaintext.",
    "Your peer can still copy or record what they see."
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
    "After destruction",
    "Analytics",
    "Limitations"
  ]);
  expect(await page.locator(".security-document p").allTextContents()).toEqual([
    "410 is designed for one-time conversations between two browsers.",
    "Messages are end-to-end encrypted in the browsers before they are relayed.",
    "The server does not receive message plaintext or the session encryption keys.",
    "The server necessarily sees network metadata required to operate the service, including IP addresses, connection timing and encrypted network traffic.",
    "The relay also processes the protocol metadata necessary to establish and operate a conversation.",
    "410 does not keep conversation history, message plaintext, accounts or contact lists.",
    "Active rooms exist in server memory and disappear when they are destroyed, expire, or when the service process restarts.",
    "A conversation has exactly two participants.",
    "An unused invite expires after 30 minutes.",
    "Once the second participant joins, the conversation can exist for up to 30 minutes.",
    "A consumed invite cannot be reused by another participant.",
    "If a participant disconnects, the conversation allows the existing reconnect grace period before it is destroyed.",
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

  const directPage = await context.newPage();
  const directResponse = await directPage.goto(`${baseURL}/security`, { waitUntil: "commit" });
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

  await context.close();
});

test("two contexts exchange E2E messages; consumed invite is HTTP 410; disconnect burns the room", async ({ browser, baseURL }) => {
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
  await pair.joinerContext.close();
  await expect(pair.creator.getByText("Connection lost.")).toBeVisible();
  await expect(pair.creator.getByText(/This conversation will be gone in 00:0[1-2]/)).toBeVisible();
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
