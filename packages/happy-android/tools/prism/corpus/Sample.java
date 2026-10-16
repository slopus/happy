package com.example;

import java.util.List;

/** Javadoc with @param tags. */
public final class Sample<T extends Comparable<T>> {
    private static final int LIMIT = 0x1F;
    @Override
    public String toString() {
        String s = "quoted \"text\"";
        char c = 'x';
        for (int i = 0; i < LIMIT; i++) { s += i * 2.5e3; }
        return s; // trailing
    }
}
