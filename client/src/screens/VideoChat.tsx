import { useCallback, useEffect, useState } from "react";
import { useSocket } from "../context/SocketProvider";
import peerservice from "../service/peer";
import ReactPlayer from "react-player";
import { Button } from "../components/ui/button";
import Messages from "../components/Messages";
import { ScreenShare, StepBack, StepForward } from "lucide-react";
import { ClipLoader } from "react-spinners"; // Import the spinner
import { useTheme } from "../components/theme-provider";
import { useNavigate } from "react-router-dom";

interface Offer {
  offer: RTCSessionDescriptionInit;
  from: string;
}

interface Answer {
  answer: RTCSessionDescriptionInit;
  from: string;
}

interface NegotiationDone {
  answer: RTCSessionDescriptionInit;
  to: string;
}

export default function VideoChat() {
  const { socket } = useSocket();
  const [remoteSocketId, setRemoteSocketId] = useState<string | null>(null);
  const [myStream, setMyStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [flag, setFlag] = useState(false);
  const [messagesArray, setMessagesArray] = useState<
    Array<{ sender: string; message: string }>
  >([]);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const theme = useTheme();
  const navigate = useNavigate();

  const loaderColor = theme.theme === "dark" ? "#D1D5DB" : "#4B5563";
  

  const getUserStream = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: {
        echoCancellation: true,  
        noiseSuppression: true,  
        autoGainControl: true, 
        sampleRate: 48000, // CD-quality audio sample rate
        sampleSize: 16,    // Higher sample size
        channelCount: 2    // Stereo audio
      }
    });
    // const processedStream = processAudio(stream);
    setMyStream(stream);
  }, []);

  useEffect(() => {
    getUserStream();
  }, [getUserStream, myStream]);

  const sendStream = useCallback(() => {
    if (myStream) {
      // console.log("send Stream");
      const videoTrack = myStream.getVideoTracks()[0];
      const audioTrack = myStream.getAudioTracks()[0];

      const senders = peerservice.peer.getSenders();

      if (videoTrack) {
        const videoSender = senders.find((s) => s.track === videoTrack);
        if (!videoSender) {
          peerservice.peer.addTrack(videoTrack, myStream); // Add video first
        }
      }

      if (audioTrack) {
        const audioSender = senders.find((s) => s.track === audioTrack);
        if (!audioSender) {
          peerservice.peer.addTrack(audioTrack, myStream); // Add audio second
        }
      }
    }
  }, [myStream]);


  const handleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
       
        const videoTrack = myStream?.getVideoTracks()[0]; 
        const screenSender = peerservice.peer.getSenders().find((s) => s.track?.kind === "video");

        if (videoTrack && screenSender) {
            screenSender.replaceTrack(videoTrack);
        }

        // Stop all tracks in the screen stream
        screenStream?.getTracks().forEach((track) => track.stop());
        setScreenStream(null);
        setMyStream(myStream); // Reset local view back to the webcam stream
        setIsScreenSharing(false);

        // Renegotiate after stopping screen sharing
        if (peerservice.peer.signalingState === "stable") {
            const offer = await peerservice.getOffer();
            socket?.emit("peer:nego:needed", { offer, to: remoteSocketId });
        }
    } else {
        try {

            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            setScreenStream(stream);
            setMyStream(stream); 
            setIsScreenSharing(true);

            const screenTrack = stream.getVideoTracks()[0];
            const videoSender = peerservice.peer.getSenders().find((s) => s.track?.kind === "video");

            if (videoSender) {
                videoSender.replaceTrack(screenTrack); 
            } else {
                peerservice.peer.addTrack(screenTrack, stream); 
            }

            if (peerservice.peer.signalingState === "stable") {
                const offer = await peerservice.getOffer();
                socket?.emit("peer:nego:needed", { offer, to: remoteSocketId });
            }
        } catch (error) {
            console.error("Error sharing screen:", error);
        }
    }
  }, [isScreenSharing, myStream, screenStream, remoteSocketId, socket]);

  const setAudioBandwidth = (peerConnection: RTCPeerConnection) => {
    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender) {
      const parameters = sender.getParameters();
      parameters.encodings[0] = {
        maxBitrate: 128000, // Set a high bitrate for audio, 128 kbps
      };
      sender.setParameters(parameters);
    }
  };
  

  const handleUserJoined = useCallback(
    async (remoteId: string) => {
      setRemoteSocketId(remoteId);
      const offer = await peerservice.getOffer();

      socket?.emit("offer", { offer, to: remoteId });
      // console.log("user joined");
    },
    [socket]
  );

  const handleIncommingOffer = useCallback(
    async ({ offer, from }: Offer) => {
      setRemoteSocketId(from);
      await getUserStream();

      if (peerservice.peer.signalingState === "stable") {
        const answer = await peerservice.getAnswer(offer);
        setAudioBandwidth(peerservice.peer);
        socket?.emit("answer", { answer, to: from });
        // console.log("Answer created and sent");
        sendStream();
      } else {
        console.warn(
          "Cannot handle incoming offer in signaling state:",
          peerservice.peer.signalingState
        );
      }
    },
    [getUserStream, socket, sendStream]
  );

  const handleIncommingAnswer = useCallback(
    async ({ answer }: Answer) => {
      if (peerservice.peer.signalingState === "have-local-offer") {
        await peerservice.setRemoteDescription(answer);
        sendStream();
        // console.log("get Answer");
      } else {
        console.warn("Peer not in a proper state to set remote description.");
      }
    },
    [sendStream]
  );

  const modifySDP = (sdp: string) => {
    return sdp.replace(
      /a=fmtp:111 .*opus.*/,
      "a=fmtp:111 maxplaybackrate=48000;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;useinbandfec=1"
    );
  };
  
  const handleNegotiationNeeded = useCallback(async () => {
    if (peerservice.peer.signalingState === "stable") {
      const currentOffer = await peerservice.getOffer();
      
  
      if (currentOffer && currentOffer.sdp) {
        const modifiedSDP = modifySDP(currentOffer.sdp);
        
        // Create a new RTCSessionDescription with the modified SDP
        const modifiedOffer = new RTCSessionDescription({
          type: currentOffer.type,
          sdp: modifiedSDP
        });

        setAudioBandwidth(peerservice.peer);
  
        socket?.emit("peer:nego:needed", {
          offer: modifiedOffer,
          to: remoteSocketId,
        });
  
        // console.log("Negotiation initiated with modified SDP.");
      }
    } else {
      console.warn("Peer is not in a stable state for negotiation.");
    }
  }, [remoteSocketId, socket]);

  // const handleNegotiationNeeded = useCallback(async () => {

  //   if (peerservice.peer.signalingState === "stable") {
  //     const currentOffer = await peerservice.getOffer();
  //     socket?.emit("peer:nego:needed", {
  //       offer: currentOffer,
  //       to: remoteSocketId,
  //     });
  //     console.log("Negotiation initiated.");
  //   } else {
  //     console.warn("Peer is not in a stable state for negotiation.");
  //   }
  // }, [remoteSocketId, socket]);

  const handleNegotiationIncomming = useCallback(
    async ({ offer, from }: Offer) => {
      if (
        peerservice.peer.signalingState === "stable" ||
        peerservice.peer.signalingState === "have-local-offer"
      ) {
        const answer = await peerservice.getAnswer(offer);
        socket?.emit("peer:nego:done", { answer, to: from });
      } else {
        console.warn(
          "Cannot handle negotiation in state:",
          peerservice.peer.signalingState
        );
      }
      // console.log("nego:incomming");
    },
    [socket]
  );

  const handleNegotiationFinal = useCallback(
    async ({ answer }: NegotiationDone) => {
      if (
        peerservice.peer.signalingState === "have-local-offer" ||
        peerservice.peer.signalingState === "have-remote-offer"
      ) {
        await peerservice.setRemoteDescription(answer);
        sendStream();
        // console.log("Final negotiation step completed.");
      } else if (peerservice.peer.signalingState === "stable") {
        console.log("Connection is stable, no need for further negotiation.");
      } else {
        console.warn(
          "Cannot set remote description: Peer connection is in state",
          peerservice.peer.signalingState
        );
      }
    },
    [sendStream]
  );

  const handleSkip = useCallback(async () => {
    // console.log("Skipping current user");

    peerservice.peer.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) {
        transceiver.stop();
      }
    });

    peerservice.peer.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
        peerservice.peer.removeTrack(sender);
      }
    });

    peerservice.peer.onicecandidate = null;
    peerservice.peer.ontrack = null;
    peerservice.peer.onnegotiationneeded = null;

    if (peerservice.peer.signalingState !== "closed") {
      // console.log("closed");
      peerservice.peer.close();
    }
    peerservice.initPeer();
    setMessagesArray([]);
    setFlag(false);

    setRemoteStream(null);
    setRemoteSocketId(null);

    socket?.emit("skip");
  }, [socket]);

  useEffect(() => {
    if (flag !== true) {
      peerservice.peer.addEventListener("negotiationneeded", handleNegotiationNeeded);
      setFlag(false);
    }

    return () => {
      peerservice.peer.removeEventListener("negotiationneeded", handleNegotiationNeeded);
    };
  }, [flag, handleNegotiationNeeded]);

  useEffect(() => {
    const handleTrackEvent = (event: RTCTrackEvent) => {
      const [incomingStream] = event.streams; // Get the MediaStream from event.streams
      // console.log("Received track event:", event.track);
      setRemoteStream(incomingStream)
    };

    peerservice.peer.addEventListener("track", handleTrackEvent);

    return () => {
      peerservice.peer.removeEventListener("track", handleTrackEvent);
    };
  }, [
    isScreenSharing,
    sendStream,
    flag
  ]);

  const userDisConnected = useCallback(async () => {
    // console.log("You've been skipped. Looking for a new user...");
    setFlag(true);
    peerservice.peer.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) {
        transceiver.stop();
      }
    });

    peerservice.peer.getSenders().forEach((sender) => {
      peerservice.peer.removeTrack(sender);
    });

    peerservice.peer.onicecandidate = null;
    peerservice.peer.ontrack = null;
    peerservice.peer.onnegotiationneeded = null;

    if (peerservice.peer.signalingState !== "closed") {
      // console.log("closed");
      peerservice.peer.close();
    }

    setRemoteStream(null);
    setRemoteSocketId(null);

    peerservice.initPeer();
    setMessagesArray([]);
  }, []);

  useEffect(() => {
    socket?.on("skipped", userDisConnected);

    return () => {
      socket?.off("skipped", userDisConnected);
    };
  }, [socket, userDisConnected]);

  useEffect(() => {
    peerservice.peer.onicecandidate = (event) => {
      if (event.candidate) {
        // console.log("Sending ICE candidate:", event.candidate);
        socket?.emit("ice-candidate", {
          candidate: event.candidate,
          to: remoteSocketId,
        });
      }
    };
  }, [socket, remoteSocketId]);

  useEffect(() => {
    socket?.on("ice-candidate", (data) => {
      if (data.candidate) {
        const candidate = new RTCIceCandidate(data.candidate);
        peerservice.peer.addIceCandidate(candidate)
          .then(() => {
            // console.log("Added ICE candidate:", candidate);
          })
          .catch((error) => {
            console.error("Error adding ICE candidate:", error);
          });
      }
    });
    
    return () => {
      socket?.off("ice-candidate");
    };
  }, [socket]);
  

  useEffect(() => {
    socket?.on("user:connect", handleUserJoined);
    socket?.on("offer", handleIncommingOffer);
    socket?.on("answer", handleIncommingAnswer);
    socket?.on("peer:nego:needed", handleNegotiationIncomming);
    socket?.on("peer:nego:final", handleNegotiationFinal);
    socket?.on("partnerDisconnected", userDisConnected);

    return () => {
      socket?.off("user:connect", handleUserJoined);
      socket?.off("offer", handleIncommingOffer);
      socket?.off("answer", handleIncommingAnswer);
      socket?.off("peer:nego:needed", handleNegotiationIncomming);
      socket?.off("peer:nego:final", handleNegotiationFinal);
      socket?.off("partnerDisconnected", userDisConnected);
    };
  }, [
    handleIncommingAnswer,
    handleIncommingOffer,
    handleNegotiationFinal,
    handleNegotiationIncomming,
    handleUserJoined,
    socket,
    userDisConnected,
  ]);


  const handleCleanup = useCallback(() => {
    // console.log("Cleaning up...");

    // Stop camera stream
    if (myStream) {
      myStream.getTracks().forEach((track) => {
        // console.log("Stopping track:", track);
        track.stop(); // Stop each media track (video/audio)
      });
      setMyStream(null); // Clear the state to ensure the stream is stopped
    }

    // Stop screen sharing stream
    if (screenStream) {
      screenStream.getTracks().forEach((track) => {
        // console.log("Stopping screen sharing track:", track);
        track.stop(); // Stop each screen sharing track
      });
      setScreenStream(null);
      setIsScreenSharing(false);
    }

    // Disconnect the socket
    if (socket) {
      socket.disconnect();
    }

    // Close and reset Peer Connection
    if (peerservice.peer.signalingState !== "closed") {
      peerservice.peer.close();
      peerservice.initPeer();  // Re-initialize the peer connection if needed
    }

    navigate('/');
    window.location.reload();
  }, [myStream, navigate, screenStream, socket]);


  return (
    <div className="flex w-screen h-full">
      {/* Left Side  */}
      <div className="border-r border-gray-200 dark:border-gray-700 w-[450px] h-[calc(100vh-64px)]">
        {myStream ? (
          <ReactPlayer
            width={"448px"}
            height={"50%"}
            url={myStream}
            playing
            muted
          />
        ) : (
          <div className="flex flex-col gap-4 items-center justify-center w-[448px] h-[50%] bg-gray-300 dark:bg-gray-700">
            <ClipLoader color={loaderColor} size={50} />
            <p className="text-gray-600 dark:text-gray-300">
              Loading your stream...
            </p>
          </div>
        )}
        {remoteStream ? (
          <ReactPlayer
            width={"448px"}
            height={"50%"}
            url={remoteStream}
            playing
            muted={false}
          />
        ) : (
          <div className="flex flex-col gap-4 items-center justify-center w-[448px] h-[50%] bg-gray-300 dark:bg-gray-700">
            <ClipLoader color={loaderColor} size={50} />
            <p className="text-gray-600 dark:text-gray-300">
              Waiting for user to connect...
            </p>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col">
        {/* Buttons */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex gap-4 h-16">
          <Button
            className="w-[200px] max-lg:w-auto gap-2"
            onClick={handleCleanup}
          >
            <StepBack size={18} />
            Stop 
          </Button>
          <Button
            className="w-[200px] max-lg:w-auto gap-2"
            onClick={handleSkip}
            disabled={remoteSocketId === null}
          >
            Skip
            <StepForward size={18} />
          </Button>
          <Button
            className="w-[200px] max-lg:w-auto gap-2"
            onClick={handleScreenShare}
          >
            <ScreenShare size={18} />
            {isScreenSharing ? "Stop Sharing Screen" : "Share Screen"}
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 max-h-[calc(100vh-128px)]">
          {screenStream ? 
          <ReactPlayer
          width={"100%"}
          height={"100%"}
          url={screenStream}
          playing
        /> :<Messages
            remoteSocketId={remoteSocketId}
            messagesArray={messagesArray}
            setMessagesArray={setMessagesArray}
          />}
        </div>
      </div>
    </div>
  );
}
