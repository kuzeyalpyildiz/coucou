//! Bounded, continuous microphone audio. Overflow discards the whole utterance,
//! never stitches non-adjacent audio together into a potentially wrong command.
use std::collections::VecDeque;

pub struct AudioBuffer {
    samples: VecDeque<f32>,
    limit: usize,
    interrupted: bool,
}

impl AudioBuffer {
    pub fn new(limit: usize) -> Self {
        Self { samples: VecDeque::new(), limit, interrupted: false }
    }

    pub fn push(&mut self, samples: &[f32]) {
        if self.samples.len().saturating_add(samples.len()) > self.limit {
            self.samples.clear();
            self.interrupted = true;
            // Wait until the consumer acknowledges the gap before accepting
            // more audio; the suffix alone must not become an action.
        }
        if !self.interrupted { self.samples.extend(samples.iter().copied()); }
    }

    pub fn take(&mut self) -> (Vec<f32>, bool) {
        let interrupted = std::mem::take(&mut self.interrupted);
        (self.samples.drain(..).collect(), interrupted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_every_callback_in_order() {
        let mut b = AudioBuffer::new(8);
        b.push(&[1.0, 2.0]);
        b.push(&[3.0, 4.0]);
        assert_eq!(b.take(), (vec![1.0, 2.0, 3.0, 4.0], false));
    }

    #[test]
    fn overflow_discards_partial_command_and_recovers() {
        let mut b = AudioBuffer::new(3);
        b.push(&[1.0, 2.0]);
        b.push(&[3.0, 4.0]);
        b.push(&[5.0]);
        assert_eq!(b.take(), (vec![], true));
        b.push(&[6.0]);
        assert_eq!(b.take(), (vec![6.0], false));
    }
}
