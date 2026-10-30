package com.chatirl.capture;

import android.util.Log;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

final class TcpVideoPublisher implements AutoCloseable {
    interface Listener {
        void onState(String state, String detail);
        void onReceiverConnected();
    }

    private static final String TAG = "ChatIRLCapture";
    private static final int QUEUE_CAPACITY = 45;

    private final String host;
    private final int port;
    private final Listener listener;
    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private volatile boolean running;
    private volatile boolean connected;
    private volatile byte[] codecConfig = new byte[0];
    private volatile Socket socket;
    private Thread senderThread;

    TcpVideoPublisher(String host, int port, Listener listener) {
        this.host = host;
        this.port = port;
        this.listener = listener;
    }

    void start() {
        if (running) return;
        running = true;
        senderThread = new Thread(this::sendLoop, "ChatIRL-TCP-Sender");
        senderThread.start();
    }

    void setCodecConfig(byte[] config) {
        codecConfig = Arrays.copyOf(config, config.length);
        if (connected && config.length > 0) queue.offer(codecConfig);
    }

    void offer(byte[] frame) {
        if (!running || !connected || frame.length == 0) return;
        if (!queue.offer(frame)) {
            queue.poll();
            queue.offer(frame);
            Log.w(TAG, "TCP queue full; dropped the oldest encoded frame");
        }
    }

    private void sendLoop() {
        while (running) {
            listener.onState("waiting", "Waiting for Mac receiver at " + host + ":" + port);
            try (Socket nextSocket = new Socket()) {
                socket = nextSocket;
                nextSocket.setTcpNoDelay(true);
                nextSocket.setSendBufferSize(1024 * 1024);
                nextSocket.connect(new InetSocketAddress(host, port), 1200);
                OutputStream output = nextSocket.getOutputStream();
                queue.clear();
                connected = true;
                byte[] config = codecConfig;
                if (config.length > 0) output.write(config);
                listener.onState("streaming", "Receiver connected; sending H.264 video");
                listener.onReceiverConnected();

                while (running && !nextSocket.isClosed()) {
                    byte[] frame = queue.poll(1, TimeUnit.SECONDS);
                    if (frame == null) continue;
                    output.write(frame);
                }
            } catch (IOException error) {
                if (running) Log.i(TAG, "Receiver unavailable: " + error.getMessage());
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                connected = false;
                socket = null;
                queue.clear();
            }

            if (running) {
                try {
                    Thread.sleep(750);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    @Override
    public void close() {
        running = false;
        connected = false;
        Socket activeSocket = socket;
        if (activeSocket != null) {
            try {
                activeSocket.close();
            } catch (IOException ignored) {
                // Closing is best-effort during service shutdown.
            }
        }
        if (senderThread != null) senderThread.interrupt();
        queue.clear();
    }
}
