package com.chatirl.capture;

import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public final class AnnexBTest {
    @Test
    public void preservesAnnexBFrames() {
        byte[] frame = {0, 0, 0, 1, 0x65, 1, 2, 3};
        assertArrayEquals(frame, AnnexB.normalize(frame));
    }

    @Test
    public void convertsLengthPrefixedFrames() {
        byte[] frame = {0, 0, 0, 3, 0x65, 1, 2, 0, 0, 0, 2, 0x41, 3};
        byte[] expected = {0, 0, 0, 1, 0x65, 1, 2, 0, 0, 0, 1, 0x41, 3};
        assertArrayEquals(expected, AnnexB.normalize(frame));
    }

    @Test
    public void convertsAvcDecoderConfigurationRecord() {
        byte[] configuration = {
                1, 0x64, 0, 0x1f, (byte) 0xff,
                (byte) 0xe1, 0, 3, 0x67, 0x64, 0,
                1, 0, 2, 0x68, (byte) 0xee
        };
        byte[] expected = {
                0, 0, 0, 1, 0x67, 0x64, 0,
                0, 0, 0, 1, 0x68, (byte) 0xee
        };
        assertArrayEquals(expected, AnnexB.normalize(configuration));
    }
}
