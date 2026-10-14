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

let roomRef = null; //Holds the Firestore room document reference
let myParticipantId = null; //Holds the participant ID for the current user
let participantsUnsubscribe = null; //let us stop listening to participant changes when we leave the call
let isInMeeting = false;//Tracks if the user is in a meeting or not

//WebRTC Tracks variable
const peerConnections = {}; //Holds the RTCPeerConnection objects for each participant
const remoteTiles = {}; //Holds the video elements for each remote participant
const connectionListeners = {}; //Holds the event listeners for each RTCPeerConnection
const pendingCandidates = {};//Holds the ICE candidates that are received before the remote description is set

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

    // Stop listeners belonging to this participant
    [remoteId, `${remoteId}-document`].forEach(key => {
        if (connectionListeners[key]) {
            connectionListeners[key]();
            delete connectionListeners[key];
        }
    });

    delete pendingCandidates[remoteId];
    removeRemoteTile(remoteId);
}

//FIRESTORE SIGNALING

// Both participants calculate the same document ID
function getPairId(firstId, secondId) {
    return [firstId, secondId].sort().join("_");
}

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

//Connect to a remote participant and set up signaling
async function connectToParticipant(remoteId) {
    if (
        !roomRef ||
        !myParticipantId ||
        remoteId === myParticipantId ||
        peerConnections[remoteId]
    ) {
        return;
    }

    const pc = createPeerConnection(remoteId);
    const pairId = getPairId(myParticipantId, remoteId);

    const connectionRef = roomRef
        .collection("connections")
        .doc(pairId);

    // The same participant always creates the offer for this pair
    const isOfferer = myParticipantId < remoteId;

    const mySide = isOfferer ? "caller" : "callee";
    const otherSide = isOfferer ? "callee" : "caller";

    const myCandidates = connectionRef.collection(
        `${mySide}Candidates`
    );

    const otherCandidates = connectionRef.collection(
        `${otherSide}Candidates`
    );

    // Publish my ICE candidates
    pc.onicecandidate = async event => {
        if (!event.candidate) {
            return;
        }

        try {
            await myCandidates.add(event.candidate.toJSON());
        } catch (error) {
            console.error("Could not save ICE candidate:", error);
        }
    };

    // Receive ICE candidates from the other participant
    connectionListeners[remoteId] = otherCandidates.onSnapshot(
        snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type !== "added") {
                    return;
                }

                const candidate = new RTCIceCandidate(
                    change.doc.data()
                );

                if (pc.remoteDescription) {
                    pc.addIceCandidate(candidate).catch(error => {
                        console.error("Could not add ICE candidate:", error);
                    });
                } else {
                    pendingCandidates[remoteId].push(candidate);
                }
            });
        },
        error => {
            console.error("ICE listener failed:", error);
        }
    );

    // Exchange offers and answers through this pair's document
    connectionListeners[`${remoteId}-document`] =
        connectionRef.onSnapshot(async snapshot => {
            const data = snapshot.data();

            if (!data) {
                return;
            }

            try {
                if (
                    isOfferer &&
                    data.answer &&
                    !pc.currentRemoteDescription
                ) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(data.answer)
                    );

                    await addPendingCandidates(remoteId, pc);
                    setStatus("Answer received. Connecting...");
                }

                if (
                    !isOfferer &&
                    data.offer &&
                    !pc.currentRemoteDescription
                ) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(data.offer)
                    );

                    await addPendingCandidates(remoteId, pc);

                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);

                    await connectionRef.update({
                        answer: {
                            type: answer.type,
                            sdp: answer.sdp
                        }
                    });
                }
            } catch (error) {
                console.error("Offer/answer exchange failed:", error);
                setStatus("Could not establish a participant connection.");
            }
        });

    // Only the designated offerer creates the offer
    if (isOfferer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await connectionRef.set({
            participants: [myParticipantId, remoteId].sort(),
            offer: {
                type: offer.type,
                sdp: offer.sdp
            }
        }, { merge: true });
    }

    console.log("Signaling initialized for:", remoteId);
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

    const requestedId = callId.trim();

    if (!requestedId) {
        setStatus("Enter a call ID.");
        return;
    }

    try {
        const requestedRoom = db.collection("calls").doc(requestedId);

        if (createNewRoom) {
            await requestedRoom.set({
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            const snapshot = await requestedRoom.get();

            if (!snapshot.exists) {
                setStatus("Call not found. Check the call ID");
                return;
            }
        }

        roomRef = requestedRoom;

        // Generate a unique participant ID for this meeting
        const participantRef = roomRef
            .collection("participants")
            .doc();

        myParticipantId = participantRef.id;

        await participantRef.set({
            joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
            active: true
        });

        isInMeeting = true;

        callInput.value = requestedId;
        callButton.disabled = true;
        answerButton.disabled = true;
        hangupButton.disabled = false;

        setStatus("Joining meeting...");

        // Discover existing participants and future arrivals
        participantsUnsubscribe = roomRef
            .collection("participants")
            .onSnapshot(snapshot => {
                const activeIds = new Set();

                snapshot.forEach(document => {
                    const participant = document.data();

                    if (participant.active === false) {
                        return;
                    }

                    const remoteId = document.id;
                    activeIds.add(remoteId);

                    if (remoteId !== myParticipantId) {
                        connectToParticipant(remoteId).catch(error => {
                            console.error(
                                "Could not connect to participant:",
                                remoteId,
                                error
                            );
                        });
                    }
                });

                updateParticipantCount(activeIds.size);

                // Clean up connections for participants who have left
                Object.keys(peerConnections).forEach(remoteId => {
                    if (!activeIds.has(remoteId)) {
                        closePeerConnection(remoteId);


                        showNotification("A participant left the meeting");
                        console.log("Participant left:", remoteId);
                    }
                });
            }, error => {
                console.error("Participant listener failed:", error);
                setStatus("Could not monitor meeting participants");
            });

        setStatus("Meeting joined. Waiting for participants...");
        showNotification("Joined meeting successfully");
    } catch (error) {
        console.error("Could not join meeting:", error);
        setStatus("Unable to join meeting. Check the console");

        await leaveMeeting();
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

    try {
        const newRoom = db.collection("calls").doc();

        await joinRoom(newRoom.id, true);
    } catch (error) {
        console.error("Could not create meeting:", error);
        setStatus("Unable to create meeting.");
    }
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
    // Stop listening for participant changes
    if (participantsUnsubscribe) {
        participantsUnsubscribe();
        participantsUnsubscribe = null;
    }

    // Close every peer connection and its signaling listeners
    Object.keys(peerConnections).forEach(remoteId => {
        closePeerConnection(remoteId);
    });

    // Stop any remaining Firestore listeners
    Object.keys(connectionListeners).forEach(key => {
        connectionListeners[key]();
        delete connectionListeners[key];
    });

    // Remove this participant from the room
    if (roomRef && myParticipantId) {
        try {
            await roomRef
                .collection("participants")
                .doc(myParticipantId)
                .delete();
        } catch (error) {
            console.error("Could not remove participant:", error);
        }
    }

    roomRef = null;
    myParticipantId = null;
    isInMeeting = false;

    updateParticipantCount(0);
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
