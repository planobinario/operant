use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use serde::{de::DeserializeOwned, Serialize};

#[derive(Clone)]
pub struct MessageSender {
    stdout: Arc<Mutex<io::Stdout>>,
}

impl MessageSender {
    pub fn new() -> Self {
        Self {
            stdout: Arc::new(Mutex::new(io::stdout())),
        }
    }

    pub fn send<T: Serialize>(&self, msg: &T) -> io::Result<()> {
        let payload = serde_json::to_vec(msg)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let len = payload.len() as u32;
        let mut out = self.stdout.lock().unwrap();
        out.write_all(&len.to_le_bytes())?;
        out.write_all(&payload)?;
        out.flush()?;
        Ok(())
    }
}

pub fn read_message<T: DeserializeOwned>() -> io::Result<Option<T>> {
    let mut len_buf = [0u8; 4];
    let mut stdin = io::stdin().lock();
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let length = u32::from_le_bytes(len_buf) as usize;
    if length == 0 || length > 10 * 1024 * 1024 {
        return Ok(None);
    }
    let mut buf = vec![0u8; length];
    stdin.read_exact(&mut buf)?;
    match serde_json::from_slice(&buf) {
        Ok(val) => Ok(Some(val)),
        Err(err) => {
            eprintln!("[protocol] JSON decode error: {}", err);
            Ok(None)
        }
    }
}
