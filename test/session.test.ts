import { describe, it, expect } from "vitest";
import { sign, verify, parseCookie, sessionCookie, clearSessionCookie } from "../worker/session";

const SECRET = "test-secret-key";

describe("session sign/verify", () => {
  it("round-trips a payload", async () => {
    const p = { athlete_id: 12345, iat: 1700000000 };
    const token = await sign(p, SECRET);
    const decoded = await verify(token, SECRET);
    expect(decoded).toEqual(p);
  });

  it("rejects a tampered body", async () => {
    const token = await sign({ athlete_id: 1, iat: 0 }, SECRET);
    const [body, sig] = token.split(".");
    // flip a bit in the body
    const tampered = `${body}X.${sig}`;
    expect(await verify(tampered, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await sign({ athlete_id: 1, iat: 0 }, "other-secret");
    expect(await verify(token, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verify("not-a-token", SECRET)).toBeNull();
    expect(await verify("", SECRET)).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("parseCookie extracts named cookie from header", () => {
    expect(parseCookie("sid=abc; other=1", "sid")).toBe("abc");
    expect(parseCookie("other=1; sid=abc", "sid")).toBe("abc");
    expect(parseCookie("other=1", "sid")).toBeNull();
    expect(parseCookie(null, "sid")).toBeNull();
  });

  it("sessionCookie has HttpOnly+Secure+SameSite flags over https", () => {
    const req = new Request("https://example.com/");
    const c = sessionCookie("tok", req);
    expect(c).toMatch(/sid=tok/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
  });

  it("sessionCookie drops Secure for http://localhost so local dev works", () => {
    const req = new Request("http://localhost:5173/");
    const c = sessionCookie("tok", req);
    expect(c).toMatch(/sid=tok/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).not.toMatch(/Secure/);
  });

  it("clearSessionCookie sets Max-Age=0", () => {
    const req = new Request("https://example.com/");
    expect(clearSessionCookie(req)).toMatch(/Max-Age=0/);
  });
});
