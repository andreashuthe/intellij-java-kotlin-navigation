package demo;

public class EntityService {
    private EntityRepository repository;
    private int unused;

    public EntityService(EntityRepository repo) {
        this.repository = repo;
    }

    public boolean exists(Object o) {
        return repository.contains(o);
    }

    public void save(Object o) {
        if (!exists(o)) {
            repository.merge(o);
        }
        repository.flush();
    }
}
