import { minecraftAudioCatalog } from "./minecraft-audio-catalog.js";

export function renderMinecraftAudioLibrary(): void {
  const trackList = document.querySelector<HTMLElement>("#minecraftAudioTracks");
  const presetField = document.querySelector<HTMLSelectElement>("#focusSoundPreset");
  if (!trackList || !presetField || trackList.childElementCount) return;

  const trackFragment = document.createDocumentFragment();
  const optionFragment = document.createDocumentFragment();
  for (const track of minecraftAudioCatalog) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "audio-track-row";
    button.dataset.focusPreset = track.id;

    const identity = document.createElement("span");
    const title = document.createElement("strong");
    const composer = document.createElement("small");
    const action = document.createElement("em");
    title.textContent = track.title;
    composer.textContent = track.composer;
    action.textContent = "Play";
    identity.append(title, composer);
    button.append(identity, action);
    trackFragment.append(button);

    const option = document.createElement("option");
    option.value = track.id;
    option.textContent = `${track.title} — ${track.composer}`;
    optionFragment.append(option);
  }

  trackList.append(trackFragment);
  presetField.append(optionFragment);
}
