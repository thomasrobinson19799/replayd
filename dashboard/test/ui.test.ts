// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Button from "../app/components/ui/Button.vue";
import Input from "../app/components/ui/Input.vue";
import Tabs from "../app/components/ui/Tabs.vue";
import DataTable from "../app/components/ui/DataTable.vue";
import Copy from "../app/components/ui/CopyButton.vue";
import NetworkDetail from '../app/components/NetworkDetail.vue';
import { passwordError, safeReturnPath } from "../app/utils/account";
describe("shared controls", () => {
  it('pretty prints captured JSON bodies and preserves plain text', () => {
    const w = mount(NetworkDetail, { props: { item: { ts:1,method:'GET',url:'/x',status:200,duration:5,detail:{ resBody:'{"ok":true}', reqBody:'plain text' } } }, global: { stubs: { UiBadge:true } } });
    expect(w.findAll('pre')[0]!.text()).toBe('{\n  "ok": true\n}');
    expect(w.findAll('pre')[1]!.text()).toBe('plain text');
  });
  it("busy button prevents submission and announces its state", async () => {
    const click = vi.fn();
    const w = mount(Button, {
      props: { busy: true, onClick: click },
      slots: { default: "Save" },
    });
    expect(w.attributes("aria-busy")).toBe("true");
    expect(w.attributes("type")).toBe("button");
    await w.trigger("click");
    expect(click).not.toHaveBeenCalled();
  });
  it("associates field labels and validation, preserving native input attributes", async () => {
    const w = mount(Input, {
      props: { label: "Email", error: "Required" },
      attrs: { type: "email", required: true },
    });
    expect(w.find("label").attributes("for")).toBe(
      w.find("input").attributes("id"),
    );
    expect(w.find("input").attributes("aria-invalid")).toBe("true");
    expect(w.find("input").attributes("aria-describedby")).toBe(
      w.find("small").attributes("id"),
    );
    await w.find("input").setValue("test@example.com");
    expect(w.emitted("update:modelValue")?.[0]).toEqual(["test@example.com"]);
  });
  it("tabs expose selection and navigate with the keyboard", async () => {
    const w = mount(Tabs, {
      props: {
        modelValue: "one",
        label: "Settings",
        items: [
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ],
      },
    });
    expect(w.findAll("button")[0]?.attributes("aria-selected")).toBe("true");
    await w.findAll("button")[0]!.trigger("keydown", { key: "ArrowRight" });
    expect(w.emitted("update:modelValue")?.[0]).toEqual(["two"]);
  });
  it("table sorting is explicit and keyboard row navigation leaves form controls alone", async () => {
    const w = mount(DataTable, {
      attachTo: document.body,
      props: {
        label: "Issues",
        sort: "events",
        columns: [{ key: "events", label: "Events", sortable: true }],
      },
      slots: {
        default:
          '<tbody><tr data-row><td><a href="#one">One</a></td></tr><tr data-row><td><a href="#two">Two</a></td></tr></tbody>',
      },
    });
    expect(w.find("th").attributes("aria-sort")).toBe("descending");
    await w.find("th button").trigger("click");
    expect(w.emitted("sort")?.[0]).toEqual(["events"]);
    await w.findAll("a")[0]!.trigger("keydown", { key: "j" });
    expect(document.activeElement).toBe(w.findAll("a")[1]!.element);
    w.unmount();
  });
  it("copies a value and announces success without exposing it in a notification", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const w = mount(Copy, {
      props: { text: "test-value" },
      global: { components: { UiButton: Button } },
    });
    await w.find("button").trigger("click");
    expect(writeText).toHaveBeenCalledWith("test-value");
    expect(w.text()).toContain("Copied");
    w.unmount();
  });
});
describe("account validation", () => {
  it("uses Unicode characters for minimum length and bytes for maximum", () => {
    expect(passwordError("short")).toBeTruthy();
    expect(passwordError("a".repeat(10))).toBe("");
    expect(passwordError("😀".repeat(65))).toBeTruthy();
  });
  it("accepts only internal redirect paths", () => {
    expect(safeReturnPath("/projects/demo/issues?q=a")).toContain("/projects/");
    for (const path of [
      "//outside.test",
      "/\\outside.test",
      "https://outside.test",
      undefined,
    ])
      expect(safeReturnPath(path)).toBe("/");
  });
});
