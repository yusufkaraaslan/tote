package com.tote.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class SocketBudgetTest {
    @Test public void boundsBytesAndCountsWithoutDroppingAcceptedFrames() {
        SocketBudget budget = new SocketBudget(10, 2);
        long first = budget.reserve(6), second = budget.reserve(4);
        assertTrue(first > 0); assertTrue(second > first);
        assertEquals(0, budget.reserve(1)); assertEquals(10, budget.bytes());
        budget.release(second); budget.release(second); budget.release(999);
        assertEquals(6, budget.bytes()); assertEquals(0, budget.reserve(5));
        assertTrue(budget.reserve(4) > 0);
        budget.close(); assertEquals(0, budget.bytes()); assertEquals(0, budget.reserve(1));
    }
    @Test public void boundsTinyFramesAndRejectsInvalidSizes() {
        SocketBudget budget = new SocketBudget(100, 2);
        assertEquals(0, budget.reserve(-1));
        assertTrue(budget.reserve(0) > 0); assertTrue(budget.reserve(0) > 0);
        assertEquals(0, budget.reserve(0));
        assertEquals(0, budget.reserve(Long.MAX_VALUE));
    }
}
