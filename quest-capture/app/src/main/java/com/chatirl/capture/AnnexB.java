package com.chatirl.capture;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

final class AnnexB {
    private static final byte[] START_CODE = new byte[] {0, 0, 0, 1};

    private AnnexB() {}

    static byte[] normalize(byte[] data) {
        if (data.length == 0 || hasStartCode(data)) return data;
        if ((data[0] & 0xff) == 1) {
            byte[] configuration = fromAvcConfigurationRecord(data);
            if (configuration != null) return configuration;
        }

        ByteBuffer input = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN);
        ByteArrayOutputStream output = new ByteArrayOutputStream(data.length + 32);
        while (input.remaining() >= 4) {
            int length = input.getInt();
            if (length <= 0 || length > input.remaining()) return data;
            output.write(START_CODE, 0, START_CODE.length);
            output.write(data, input.position(), length);
            input.position(input.position() + length);
        }
        return input.hasRemaining() ? data : output.toByteArray();
    }

    static byte[] combine(byte[] first, byte[] second) {
        byte[] left = normalize(first == null ? new byte[0] : first);
        byte[] right = normalize(second == null ? new byte[0] : second);
        byte[] combined = new byte[left.length + right.length];
        System.arraycopy(left, 0, combined, 0, left.length);
        System.arraycopy(right, 0, combined, left.length, right.length);
        return combined;
    }

    private static boolean hasStartCode(byte[] data) {
        return data.length >= 4 && data[0] == 0 && data[1] == 0
                && (data[2] == 1 || (data[2] == 0 && data[3] == 1));
    }

    private static byte[] fromAvcConfigurationRecord(byte[] data) {
        if (data.length < 7) return null;
        try {
            int position = 5;
            int spsCount = data[position++] & 0x1f;
            ByteArrayOutputStream output = new ByteArrayOutputStream(data.length + 16);
            position = copyParameterSets(data, position, spsCount, output);
            if (position < 0 || position >= data.length) return null;
            int ppsCount = data[position++] & 0xff;
            position = copyParameterSets(data, position, ppsCount, output);
            return position < 0 ? null : output.toByteArray();
        } catch (IndexOutOfBoundsException error) {
            return null;
        }
    }

    private static int copyParameterSets(
            byte[] data,
            int position,
            int count,
            ByteArrayOutputStream output
    ) {
        for (int index = 0; index < count; index++) {
            if (position + 2 > data.length) return -1;
            int length = ((data[position] & 0xff) << 8) | (data[position + 1] & 0xff);
            position += 2;
            if (length <= 0 || position + length > data.length) return -1;
            output.write(START_CODE, 0, START_CODE.length);
            output.write(data, position, length);
            position += length;
        }
        return position;
    }
}
