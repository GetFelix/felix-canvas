// Rooms people make themselves: the rooms list under the room name, the Share
// panel of a room you are in, and the page an invite link opens.
import { Check, ChevronDown, Copy, Link, LogOut, Plus, Trash2, X, createIcons } from "lucide";

import { popover, type Chrome } from "./chrome.js";
import {
  RoomsApi,
  RoomsError,
  expiresIn,
  inviteLink,
  roomLink,
  type RoomList,
  type RoomView,
} from "./rooms.js";

const element = <T extends Element = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;

function drawIcons(): void {
  createIcons({
    icons: { Check, ChevronDown, Copy, Link, LogOut, Plus, Trash2, X },
    nameAttr: "data-rooms-icon",
  });
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const created = Object.assign(document.createElement(tag), props);
  created.append(...children);
  return created;
}

function icon(name: string): HTMLElement {
  const placeholder = document.createElement("i");
  placeholder.dataset.roomsIcon = name;
  return placeholder;
}

/** Go to a room, leaving any invite behind in the address. */
function openRoom(room: string): void {
  location.assign(roomLink(room));
}

/**
 * The rooms list, and the Share panel when the open room is one people made.
 * Does nothing on a deployment without the rooms service.
 */
export class RoomPanels {
  readonly #api: RoomsApi;
  readonly #chrome: Chrome;
  readonly #room: string;
  #view: RoomView | null = null;

  constructor(api: RoomsApi, chrome: Chrome, room: string) {
    this.#api = api;
    this.#chrome = chrome;
    this.#room = room;
  }

  async start(): Promise<void> {
    if (!(await RoomsApi.available())) return;
    this.#wireRooms();
    try {
      this.#view = await this.#api.get(this.#room);
    } catch {
      return;
    }
    if (!this.#view) return;
    this.#chrome.setRoomTitle(this.#view.title);
    this.#wireShare();
  }

  #wireRooms(): void {
    const button = element<HTMLButtonElement>("rooms-button");
    button.disabled = false;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.dataset.tip = "Your rooms";
    // An SVG once the icons are drawn, which has no `hidden` property.
    element("rooms-chevron").removeAttribute("hidden");
    popover(button, element("rooms"), (open) => {
      if (open) void this.#loadRooms();
    });
    const form = element<HTMLFormElement>("rooms-new");
    const input = element<HTMLInputElement>("rooms-new-name");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) return input.focus();
      const submit = form.querySelector("button")!;
      submit.disabled = true;
      this.#api
        .create(title)
        .then((room) => openRoom(room.id))
        .catch((err: unknown) => {
          submit.disabled = false;
          this.#chrome.toast(message(err));
        });
    });
  }

  async #loadRooms(): Promise<void> {
    let list: RoomList;
    try {
      list = await this.#api.list();
    } catch (err) {
      this.#chrome.toast(message(err));
      return;
    }
    const items = list.rooms.map((room) => {
      const current = room.id === this.#room;
      const link = node(
        "a",
        { href: roomLink(room.id), className: "room-item" },
        node("span", { className: "room-item-title", textContent: room.title }),
        node("span", {
          className: "room-item-meta",
          textContent: `${room.owner ? "Yours" : "Shared with you"} · ${people(room.members)}`,
        }),
      );
      if (current) {
        link.setAttribute("aria-current", "page");
        link.append(icon("check"));
      }
      return node("li", {}, link);
    });
    element("rooms-list").replaceChildren(...items);
    element("rooms-empty").hidden = items.length > 0;
    element("rooms-count").textContent = `${list.owned} of ${list.limit} yours`;
    const full = list.owned >= list.limit;
    const input = element<HTMLInputElement>("rooms-new-name");
    input.disabled = full;
    input.placeholder = full ? "Delete a room to make another" : "Name a new room";
    element<HTMLButtonElement>("rooms-create").disabled = full;
    drawIcons();
  }

  #wireShare(): void {
    const panel = element("share-panel");
    this.#chrome.shareWith(panel, (open) => {
      if (open) {
        this.#renderShare();
        void this.#reloadView();
      }
    });
    element("invite-create").addEventListener("click", () => void this.#createInvite());
    element("room-leave").addEventListener("click", () => void this.#leave());
    element("room-copy").addEventListener("click", () => void this.#copy(roomLink(this.#room)));
    const dialog = element<HTMLDialogElement>("delete-room");
    element("room-delete").addEventListener("click", () => {
      element("delete-room-detail").textContent =
        `Everyone loses access to “${this.#view?.title ?? ""}”, and what was drawn there is gone for good.`;
      dialog.showModal();
    });
    dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
    element("delete-room-confirm").addEventListener("click", () => {
      this.#api
        .delete(this.#room)
        .then(() => openRoom("lobby"))
        .catch((err: unknown) => {
          dialog.close();
          this.#chrome.toast(message(err));
        });
    });
  }

  async #reloadView(): Promise<void> {
    try {
      const view = await this.#api.get(this.#room);
      if (!view) return;
      this.#view = view;
      this.#renderShare();
    } catch {}
  }

  #renderShare(): void {
    const view = this.#view;
    if (!view) return;
    element("share-invites").hidden = !view.owner;
    element("share-member").hidden = view.owner;
    element("room-delete").hidden = !view.owner;
    element("room-leave").hidden = view.owner;

    element("invite-list").replaceChildren(
      ...view.invites.map((invite) => {
        const link = inviteLink(invite.token);
        const address = node("input", {
          className: "invite-url mono",
          value: link,
          readOnly: true,
        });
        address.setAttribute("aria-label", "Invite link");
        address.addEventListener("focus", () => address.select());
        const copy = node("button", { className: "icon-button", type: "button" }, icon("copy"));
        copy.setAttribute("aria-label", "Copy invite link");
        copy.dataset.tip = "Copy";
        copy.addEventListener("click", () => void this.#copy(link));
        const revoke = node("button", { className: "icon-button", type: "button" }, icon("x"));
        revoke.setAttribute("aria-label", "Revoke invite link");
        revoke.dataset.tip = "Revoke: the link stops working";
        revoke.addEventListener("click", () => void this.#revoke(invite.id));
        return node(
          "li",
          { className: "invite-row" },
          address,
          copy,
          revoke,
          node("span", {
            className: "invite-expiry",
            textContent: `Expires ${expiresIn(invite.expires)}`,
          }),
        );
      }),
    );
    element<HTMLButtonElement>("invite-create").disabled =
      view.invites.length >= view.limits.invites;

    element("access-count").textContent = `${view.members.length} of ${view.limits.members}`;
    element("access-list").replaceChildren(
      ...view.members.map((member) => {
        const status = member.owner ? "Owner" : member.you ? "You" : "";
        const row = node(
          "li",
          { className: "person" },
          node("span", {
            className: "avatar",
            textContent: [...member.name][0]?.toUpperCase() ?? "?",
          }),
          node("span", {
            className: "person-name",
            textContent: member.you ? `${member.name} (you)` : member.name,
          }),
        );
        if (view.owner && !member.owner) {
          const remove = node("button", {
            className: "button small",
            type: "button",
            textContent: "Remove",
          });
          remove.setAttribute("aria-label", `Remove ${member.name}`);
          remove.addEventListener("click", () => void this.#remove(member.id, member.name));
          row.append(remove);
        } else {
          row.append(node("span", { className: "person-status", textContent: status }));
        }
        return row;
      }),
    );
    drawIcons();
  }

  async #createInvite(): Promise<void> {
    try {
      const invite = await this.#api.invite(this.#room);
      await this.#reloadView();
      await this.#copy(inviteLink(invite.token), "Invite link copied");
    } catch (err) {
      this.#chrome.toast(message(err));
    }
  }

  async #revoke(invite: string): Promise<void> {
    try {
      await this.#api.revokeInvite(this.#room, invite);
      await this.#reloadView();
      this.#chrome.toast("That link no longer works");
    } catch (err) {
      this.#chrome.toast(message(err));
    }
  }

  async #remove(member: string, name: string): Promise<void> {
    try {
      await this.#api.removeMember(this.#room, member);
      await this.#reloadView();
      this.#chrome.toast(`${name} no longer has access`);
    } catch (err) {
      this.#chrome.toast(message(err));
    }
  }

  async #leave(): Promise<void> {
    try {
      await this.#api.removeMember(this.#room, "me");
      openRoom("lobby");
    } catch (err) {
      this.#chrome.toast(message(err));
    }
  }

  async #copy(text: string, done = "Link copied"): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#chrome.toast(done);
    } catch {
      this.#chrome.toast("Select the link and copy it");
    }
  }
}

/**
 * The page an invite link opens: who invited you to what, and a button to
 * join. Never resolves; joining goes to the room.
 */
export async function showInvite(
  api: RoomsApi,
  invite: string,
  view: { who: string; onSignIn: () => void },
): Promise<never> {
  element("app").classList.add("refused");
  element("joining").hidden = true;
  const card = element("invite");
  const join = element<HTMLButtonElement>("invite-join");
  const show = (title: string, detail: string, canJoin: boolean) => {
    element("invite-title").textContent = title;
    element("invite-detail").textContent = detail;
    join.hidden = !canJoin;
    element("invite-lobby").classList.toggle("primary", !canJoin);
    element("invite-who").textContent = view.who ? `Signed in as ${view.who}` : "";
    card.hidden = false;
    (canJoin ? join : element("invite-lobby")).focus();
  };
  const refuse = (err: unknown) => {
    if (err instanceof RoomsError && err.code === "signed_out") return view.onSignIn();
    const expired = err instanceof RoomsError && err.code === "invite_expired";
    const invalid = err instanceof RoomsError && err.code === "invite_invalid";
    show(
      expired
        ? "This invite link has expired"
        : invalid
          ? "This invite link no longer works"
          : "This invite can't be used",
      expired || invalid ? "Ask whoever sent it for a new one." : message(err),
      false,
    );
  };

  if (!(await RoomsApi.available())) {
    show(
      "Invites aren't available here",
      "This canvas only has the rooms its owner set up.",
      false,
    );
    return new Promise(() => {});
  }
  try {
    const preview = await api.preview(invite);
    if (preview.member) {
      openRoom(preview.room);
      return new Promise(() => {});
    }
    show(
      `Join “${preview.title}”`,
      `${preview.ownerName || "Someone"} invited you to draw together. Everyone in the room sees the same canvas.`,
      true,
    );
    join.onclick = () => {
      join.disabled = true;
      api
        .accept(invite)
        .then((room) => openRoom(room.id))
        .catch((err: unknown) => {
          join.disabled = false;
          refuse(err);
        });
    };
  } catch (err) {
    refuse(err);
  }
  return new Promise(() => {});
}

function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

function message(err: unknown): string {
  return err instanceof RoomsError ? err.message : "Something went wrong. Try again soon.";
}
