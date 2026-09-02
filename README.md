# Vigil

Vigil is a local-first focus-enforcement app for macOS with supervised iPhone
companions for Instagram, YouTube, and Snapchat.

## Agent update commands

Update the installed Vigil Mac app:

```sh
npm run agent:update
```

Update either Personal Team-compatible companion independently on the connected,
paired iPhone:

```sh
npm run agent:update:instagram
npm run agent:update:youtube
npm run agent:update:snapchat
```

To check and update all companions in one transaction, run:

```sh
npm run agent:update:phone
```

Agents should run the app-specific command for the companion they are working
on. Each phone command uses the verified deployment suite: it bumps only changed
release inputs, audits all four policy levels, renews any selected companion
whose Personal Team signature expires within 48 hours or which cannot launch,
keeps the matching supervised policy synchronized, and verifies that every
selected companion launches and remains running before reporting success. It
does not reboot, erase, re-enroll, or weaken supervision.

The iPhone must be unlocked when profile installation needs it, trusted and
paired, visible to Xcode, and reachable through a wired or wireless CoreDevice
connection. USB is not required for normal companion updates. If the
non-removable supervised policy itself has changed, Vigil will ask for USB so it
can retain the verified supervisor-keybag installation transaction. Personal
Team signing remains the supported default and requires no paid Apple Developer
Program membership.
