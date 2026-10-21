#ifndef ORBIT_TRAY_DARWIN_H
#define ORBIT_TRAY_DARWIN_H

// Installs the Orbit SSH item in the macOS menu bar. The PNG data, when set,
// carries the menu bar artwork from the Go side; it is copied before the call
// returns, so the caller may free it right away. Safe to call from any thread;
// the work is moved to the main queue because AppKit requires it.
void OrbitTrayCreate(const char *title, const unsigned char *imageData, int imageLength);

// Removes the menu bar item again.
void OrbitTrayDestroy(void);

#endif /* ORBIT_TRAY_DARWIN_H */
