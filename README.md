# WebWriter
<img width="1900" height="905" alt="screen" src="https://github.com/user-attachments/assets/10e4bd8d-2b2b-493e-b374-2ac334045373" />

So what does this Webapp do? It's basically a super minimalistic self-hostable novel writing site. You can create novels, give them covers, create sub sections called "books" and make new chapters in a super lightweight editor that is as distraction-free as possible.

It also has an option to integrate with LiteWriter, the android app. You just need to fire up the WebDAV server in the app and make sure both the webapp and the phone are in the same network (I recommend using tailscale).
This allows the webapp to edit the novels on your phone conviniently from a desktop anywhere.

## Installation
You first need to set the stuff in `.env.example` so that google backup works and so that you can set your port. After that it's just:
- npm install
- npm start

## Support
I'll provide none. I'm happy with the way it is and I just can't be bothered to go further. I only wanted something to edit my LiteWriter stuff with and now I have it.

## Complaints
"Hurr durr, this is vibe-coded!" I hear you say. Yes, partially. I may make something actually cool in the future, in which case I'll nuke this repo, but for now I'm content with this simple app.
