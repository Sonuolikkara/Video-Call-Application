"use strict";

//HTML ELEMENTS

const webcamButton = document.getElementById("webcamButton");
const callButton = document.getElementById("callButton");
const answerButton = document.getElementById("answerButton");
const webcamVideo = document.getElementById("webcamVideo");
const micButton = document.getElementById("micButton");
const cameraButton = document.getElementById("cameraButton");
const hangupButton = document.getElementById("hangupButton");
const videoGrid = document.getElementById("videoGrid");
const callInput = document.getElementById("callInput");
const callStatus = document.getElementById("callStatus");
const participantCount = document.getElementById("participantCount");

//Camera and Microphone tracks variable
let localStream = null;

let currentRoomId = null; //Holds the Firestore room document reference
let myParticipantId = null; //Holds the participant ID for the current user
let isInMeeting = false;//Tracks if the user is in a meeting or not

//WebRTC Tracks variable
const peerConnections = {}; //Holds the RTCPeerConnection objects for each participant
const remoteTiles = {}; //Holds the video elements for each remote participant
const pendingCandidates = {};//Holds the ICE candidates that are received before the remote description is set
const activeParticipantIds = new Set();//Holds the Paricipant Counts

//UI HELPERS

function setStatus(message) {
    if (callStatus) {
        callStatus.textContent = message;
    }
}

function showNotification(message) {
    console.log(message);

    const notification = document.getElementById("notification");

    if (notification) {
        notification.textContent = message;
        notification.classList.add("show");

        setTimeout(() => {
            notification.classList.remove("show");
        }, 3500);
    }
}

function updateParticipantCount(count) {
    if (participantCount) {
        participantCount.textContent = `Participants (${count})`;
    }
}

// Web Cam Function

async function startWebcam() {
    if (localStream) {
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        webcamVideo.srcObject = localStream;
        await webcamVideo.play().catch(() => { });

        webcamButton.disabled = true;
        callButton.disabled = false;
        answerButton.disabled = false;
        micButton.disabled = false;
        cameraButton.disabled = false;

        console.log("Camera and microphone started");
        setStatus("Camera and microphone ready");
        showNotification("Camera and microphone enabled");
    } catch (error) {
        console.error("Could not access camera or microphone:", error);
        setStatus("Camera or microphone access failed");
    }
}

//StartWebCam Event Listener
webcamButton.addEventListener("click", startWebcam);

//Toggle Microphone
function toggleMicrophone() {
    if (!localStream) {
        return;
    }

    const tracks = localStream.getAudioTracks();

    tracks.forEach(track => {
        track.enabled = !track.enabled;
    });

    const enabled = tracks.some(track => track.enabled);

    micButton.textContent = enabled
        ? "Mute Microphone"
        : "Unmute Microphone";
}

//Toggle Camera
function toggleCamera() {
    if (!localStream) {
        return;
    }

    const tracks = localStream.getVideoTracks();

    tracks.forEach(track => {
        track.enabled = !track.enabled;
    });

    const enabled = tracks.some(track => track.enabled);
    cameraButton.textContent = enabled
        ? "Turn Camera Off"
        : "Turn Camera On";
}

// Mic and Camera Event Listeners
micButton.addEventListener("click", toggleMicrophone);
cameraButton.addEventListener("click", toggleCamera);

// Create Remote Participant Video UI Tile
function createRemoteTile(participantId) {
    if (remoteTiles[participantId]) {
        return remoteTiles[participantId].video;
    }

    const tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = `participant-${participantId}`;

    const heading = document.createElement("h3");
    heading.textContent = "Participant";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    tile.append(heading, video);
    videoGrid.appendChild(tile);

    remoteTiles[participantId] = { tile, video };

    return video;
}

//Remove Remote Participant Video UI Tile
function removeRemoteTile(participantId) {
    const remote = remoteTiles[participantId];

    if (!remote) {
        return;
    }

    remote.video.srcObject = null;
    remote.tile.remove();

    delete remoteTiles[participantId];
}

//WebRTC Call Function

function createPeerConnection(remoteId) {
    if (!localStream) {
        throw new Error("Start the camera before joining a call");
    }

    if (peerConnections[remoteId]) {
        return peerConnections[remoteId];
    }

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" }
        ]
    });

    peerConnections[remoteId] = pc;
    pendingCandidates[remoteId] = [];

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    pc.ontrack = async event => {
        const video = createRemoteTile(remoteId);

        if (event.streams && event.streams[0]) {
            video.srcObject = event.streams[0];
        } else {
            // Fallback when a track arrives without a stream
            if (!video.srcObject) {
                video.srcObject = new MediaStream();
            }

            video.srcObject.addTrack(event.track);
        }

        try {
            await video.play();
        } catch (error) {
            console.warn("Remote video playback needs user interaction", error);
        }

        console.log("Remote track received", remoteId);
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection to ${remoteId}:`, pc.connectionState);

        if (pc.connectionState === "connected") {
            setStatus("Connected to meeting.");
        } else if (pc.connectionState === "failed") {
            setStatus(`Connection to participant failed.`);
        } else if (pc.connectionState === "disconnected") {
            console.warn("Participant connection disconnected:", remoteId);
        }
    };

    return pc;
}

//Close WebRTC Peer Connection and Clean Up
function closePeerConnection(remoteId) {
    const pc = peerConnections[remoteId];

    if (pc) {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.close();
        delete peerConnections[remoteId];
    }

    delete pendingCandidates[remoteId];
    removeRemoteTile(remoteId);
}

//FIRESTORE SIGNALING


async function addPendingCandidates(remoteId, pc) {
    const candidates = pendingCandidates[remoteId] || [];

    while (candidates.length > 0 && pc.remoteDescription) {
        const candidate = candidates.shift();

        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            console.error("Could not add ICE candidate:", error);
        }
    }
}

//SignalR WebRTC Signaling Event Handlers

// Receive an offer from another participant
signalRConnection.on("ReceiveOffer", async (remoteId, offer) => {
    try {
        const pc = createPeerConnection(remoteId);

        await pc.setRemoteDescription(
            new RTCSessionDescription(offer)
        );

        // Apply ICE candidates received before the offer
        await addPendingCandidates(remoteId, pc);

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        await signalRConnection.invoke(
            "SendAnswer",
            remoteId,
            {
                type: answer.type,
                sdp: answer.sdp
            }
        );

        console.log("Answer sent to:", remoteId);
    } catch (error) {
        console.error("Could not process offer:", error);
        setStatus("Could not process the incoming call.");
    }
});

// Receive an answer to an offer I sent
signalRConnection.on("ReceiveAnswer", async (remoteId, answer) => {
    try {
        const pc = peerConnections[remoteId];

        if (!pc) {
            console.warn("Peer connection not found:", remoteId);
            return;
        }

        await pc.setRemoteDescription(
            new RTCSessionDescription(answer)
        );

        await addPendingCandidates(remoteId, pc);

        console.log("Answer received from:", remoteId);
    } catch (error) {
        console.error("Could not process answer:", error);
    }
});

// Receive an ICE candidate from another participant
signalRConnection.on(
    "ReceiveIceCandidate",
    async (remoteId, candidateData) => {
        try {
            const pc = peerConnections[remoteId];

            if (!pc) {
                console.warn(
                    "Peer connection not found for ICE candidate:",
                    remoteId
                );
                return;
            }

            const candidate = new RTCIceCandidate(candidateData);

            if (pc.remoteDescription) {
                await pc.addIceCandidate(candidate);
            } else {
                pendingCandidates[remoteId] ??= [];
                pendingCandidates[remoteId].push(candidate);
            }
        } catch (error) {
            console.error("Could not process ICE candidate:", error);
        }
    }
);


// Participants who were already in the room
let pendingParticipants = [];
signalRConnection.on("ExistingParticipants", participantIds => {
    console.log("Existing participants:", participantIds);


    // Buffer participants until our meeting identity is ready.
    if (!myParticipantId || !isInMeeting) {
        pendingParticipants.push(...participantIds);
        return;
    }

    participantIds.forEach((remoteId) => {
        if (remoteId !== myParticipantId) {
            activeParticipantIds.add(remoteId);
        }

        connectToParticipant(remoteId).catch((error) => {
            console.error("Could not connect to participant:", error);
        });
    });

    updateParticipantCount(activeParticipantIds.size);
});

// A new participant joined the room
signalRConnection.on("ParticipantJoined", remoteId => {
    console.log("Participant joined:", remoteId);

    // The meeting identity might not be initialized yet.
    if (!myParticipantId || !isInMeeting) {
        pendingParticipants.push(remoteId);
        return;
    }

    if (remoteId !== myParticipantId) {
        activeParticipantIds.add(remoteId);
    }

    updateParticipantCount(activeParticipantIds.size);

    connectToParticipant(remoteId).catch(error => {
        console.error(
            "Could not connect to new participant:",
            remoteId,
            error
        );
    });
});

// A participant left the room
signalRConnection.on("ParticipantLeft", remoteId => {
    console.log("Participant left:", remoteId);

    activeParticipantIds.delete(remoteId);

    closePeerConnection(remoteId);

    updateParticipantCount(
        activeParticipantIds.size
    );

    showNotification("A participant left the meeting.");
});

//Connect to a remote participant and set up signaling
async function connectToParticipant(remoteId) {
    if (
        !myParticipantId ||
        remoteId === myParticipantId ||
        peerConnections[remoteId]
    ) {
        return;
    }

    try {
        const pc = createPeerConnection(remoteId);

        // Decide which participant creates the offer
        // Both participants calculate the same result
        const isOfferer = myParticipantId < remoteId;

        // Send local ICE candidates through SignalR
        pc.onicecandidate = async event => {
            if (!event.candidate) {
                return;
            }

            try {
                await signalRConnection.invoke(
                    "SendIceCandidate",
                    remoteId,
                    event.candidate.toJSON()
                );
            } catch (error) {
                console.error(
                    "Could not send ICE candidate:",
                    error
                );
            }
        };

        // Only one participant creates the offer
        if (isOfferer) {
            const offer = await pc.createOffer();

            await pc.setLocalDescription(offer);

            await signalRConnection.invoke(
                "SendOffer",
                remoteId,
                {
                    type: offer.type,
                    sdp: offer.sdp
                }
            );

            console.log("Offer sent to:", remoteId);
        }

        console.log("Signaling initialized for:", remoteId);
    } catch (error) {
        console.error(
            "Could not initialize participant signaling:",
            error
        );

        setStatus("Could not connect to participant.");
    }
}

// Join Room
async function joinRoom(callId, createNewRoom = false) {
    if (!localStream) {
        setStatus("Start your camera before joining.");
        return;
    }

    if (isInMeeting) {
        setStatus("Leave your current meeting first.");
        return;
    }

    if (
        signalRConnection.state !==
        signalR.HubConnectionState.Connected
    ) {
        setStatus("Connecting to the meeting server. Please wait.");
        return;
    }

    try {
        if (createNewRoom) {
            currentRoomId =
                await signalRConnection.invoke("CreateRoom");
        } else {
            currentRoomId = callId.trim();

            if (!currentRoomId) {
                setStatus("Enter a call ID.");
                return;
            }

            await signalRConnection.invoke(
                "JoinRoom",
                currentRoomId
            );
        }

        myParticipantId = signalRConnection.connectionId;
        isInMeeting = true;
        activeParticipantIds.clear();
        activeParticipantIds.add(myParticipantId);

        updateParticipantCount(activeParticipantIds.size);

        const participantsToConnect = [...new Set(pendingParticipants)];
        pendingParticipants = [];

        participantsToConnect.forEach((remoteId) => {
            if (remoteId !== myParticipantId) {
                activeParticipantIds.add(remoteId);
            }

            connectToParticipant(remoteId).catch((error) => {
                console.error("Could not connect to participant:", error);
            });
        });

        updateParticipantCount(activeParticipantIds.size);

        callInput.value = currentRoomId;
        callButton.disabled = true;
        answerButton.disabled = true;
        hangupButton.disabled = false;

        setStatus("Meeting joined. Waiting for participants...");
        showNotification("Joined meeting successfully");
    } catch (error) {
        console.error("Could not join meeting:", error);

        currentRoomId = null;
        myParticipantId = null;
        isInMeeting = false;

        setStatus("Unable to join meeting. Check the call ID.");
    }
}

//Start a Call
async function startCall() {
    if (!localStream) {
        setStatus("Start your camera first.");
        return;
    }

    if (isInMeeting) {
        setStatus("You are already in a meeting.");
        return;
    }

    await joinRoom("", true);
}

//Join a Call
async function joinCall() {
    const callId = callInput.value.trim();

    if (!callId) {
        setStatus("Enter a call ID.");
        return;
    }

    await joinRoom(callId, false);
}

//Call and Answer Event Listeners
callButton.addEventListener("click", startCall);
answerButton.addEventListener("click", joinCall);

// Leave a Call and Clean Up Function
async function leaveMeeting() {
    const roomId = currentRoomId;

    // Tell the SignalR server that we are leaving the room
    try {
        if (
            roomId &&
            signalRConnection.state === signalR.HubConnectionState.Connected
        ) {
            await signalRConnection.invoke("LeaveRoom", roomId);
        }
    } catch (error) {
        console.error("Could not leave SignalR room:", error);
    }

    // Close all peer connections
    Object.keys(peerConnections).forEach((remoteId) => {
        closePeerConnection(remoteId);
    });

    // Reset meeting state.
    currentRoomId = null;
    myParticipantId = null;
    isInMeeting = false;
    pendingParticipants = [];
    activeParticipantIds.clear();

    updateParticipantCount(0);

    console.log("Left the meeting.");
}


//Hang Up Function
async function hangUp() {
    await leaveMeeting();

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    webcamVideo.srcObject = null;

    webcamButton.disabled = false;
    callButton.disabled = true;
    answerButton.disabled = true;
    micButton.disabled = true;
    cameraButton.disabled = true;
    hangupButton.disabled = true;

    micButton.textContent = "Mute Microphone";
    cameraButton.textContent = "Turn Camera Off";

    setStatus("You left the meeting.");
    showNotification("Meeting ended for you.");
}

//Hang Up Event Listener
hangupButton.addEventListener("click", hangUp);


callButton.disabled = true;
answerButton.disabled = true;
micButton.disabled = true;

cameraButton.disabled = true;
hangupButton.disabled = true;

updateParticipantCount(0);

console.log("WebRTC application loaded");
