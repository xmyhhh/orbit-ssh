#ifndef ORBIT_NOTIFY_DARWIN_H
#define ORBIT_NOTIFY_DARWIN_H

// Returns whether reminder delivery was scheduled (authorization is async).
int OrbitNotifyApproval(const char *title, const char *body, const char *requestID);
void OrbitNotifyForget(const char *requestID);

#endif /* ORBIT_NOTIFY_DARWIN_H */
